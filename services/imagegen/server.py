#!/usr/bin/env python3
"""
Lokaler Bildgenerierungs-Dienst (mflux/MLX auf Apple Silicon).

STRIKT INTERN: bindet NUR 127.0.0.1. Keine ausgehenden Verbindungen zur Laufzeit
(Modelle liegen im HF-Cache; HF_HUB_OFFLINE=1 wird vom LaunchDaemon gesetzt).
Spricht nur das Node-Backend lokal an — analog zu Ollama.

Modell (Apache-2.0, vor-quantisiert vom mflux-Autor):
  - "turbo" → Z-Image-Turbo 4-bit  (~9 Schritte, hohe Qualität)

Endpoints:
  GET  /health            → {status, loaded:[...], models:{...}}
  POST /generate {model, prompt, steps?, width?, height?, guidance?, seed?, negative_prompt?}
                          → {image_base64, model, seed, steps, width, height, ms}
"""
import base64
import io
import json
import os
import queue
import random
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("IMG_HOST", "127.0.0.1")
PORT = int(os.environ.get("IMG_PORT", "7870"))
PRELOAD = [m.strip() for m in os.environ.get("IMG_PRELOAD", "turbo").split(",") if m.strip()]

# Modell-Registry: logischer Name → Lade-/Default-Parameter.
MODELS = {
    "turbo": {
        "repo": "filipstrand/Z-Image-Turbo-mflux-4bit",
        "label": "Z-Image Turbo",
        "family": "z_image",
        "steps": 9, "guidance": None, "max_steps": 20,
    },
}


def _is_cached(repo: str) -> bool:
    """Liegt das Modell vollständig im HF-Cache? (Snapshot mit safetensors vorhanden)"""
    home = os.environ.get("HF_HOME", os.path.expanduser("~/.cache/huggingface"))
    base = os.path.join(home, "hub", "models--" + repo.replace("/", "--"), "snapshots")
    if not os.path.isdir(base):
        return False
    for snap in os.listdir(base):
        snap_dir = os.path.join(base, snap)
        for root, _dirs, files in os.walk(snap_dir):
            if any(f.endswith(".safetensors") for f in files):
                return True
    return False


def available_models() -> dict:
    """Nur Modelle, deren Gewichte wirklich da sind (kein kaputter UI-Button)."""
    return {k: v for k, v in MODELS.items() if _is_cached(v["repo"])}

_loaded = {}            # name → Modellobjekt (warm)

# MLX/Metal-Streams sind thread-gebunden: ALLE Modell-Operationen (Laden UND
# Generieren) müssen auf EINEM einzigen Thread laufen. Daher ein dedizierter
# Worker-Thread, der Jobs aus einer Queue abarbeitet. HTTP bleibt nebenläufig
# (Health antwortet auch während einer laufenden Generierung).
_jobs: "queue.Queue" = queue.Queue()


def _mlx_worker():
    while True:
        fn, holder, done = _jobs.get()
        try:
            holder["result"] = fn()
        except BaseException as e:  # noqa: BLE001 — Fehler an den Aufrufer durchreichen
            holder["error"] = e
        finally:
            done.set()


def run_on_mlx(fn):
    """fn auf dem MLX-Worker-Thread ausführen und Ergebnis/Fehler zurückgeben."""
    holder: dict = {}
    done = threading.Event()
    _jobs.put((fn, holder, done))
    done.wait()
    if "error" in holder:
        raise holder["error"]
    return holder.get("result")


def _build(name):
    cfg = MODELS[name]
    from mflux.models.common.config import ModelConfig
    if cfg["family"] == "z_image":
        from mflux.models.z_image.variants.z_image import ZImage
        return ZImage(model_config=ModelConfig.z_image_turbo(), model_path=cfg["repo"])
    raise ValueError(f"Unbekannte Modell-Familie: {cfg['family']}")


def get_model(name):
    """NUR vom MLX-Worker-Thread aufrufen (lazy laden, danach warm)."""
    if name not in _loaded:
        t0 = time.time()
        print(f"[imagegen] lade Modell '{name}' ({MODELS[name]['repo']}) …", flush=True)
        _loaded[name] = _build(name)
        print(f"[imagegen] '{name}' geladen in {time.time() - t0:.1f}s", flush=True)
    return _loaded[name]


def _round16(v, lo=256, hi=1536, default=1024):
    try:
        v = int(v)
    except (TypeError, ValueError):
        return default
    v = max(lo, min(hi, v))
    return (v // 16) * 16


def _to_png_bytes(result):
    """ZImage liefert PIL.Image, QwenImage ein GeneratedImage — beide vereinheitlichen."""
    # PIL.Image hat .save(buf, format=...)
    if hasattr(result, "save"):
        try:
            buf = io.BytesIO()
            result.save(buf, format="PNG")    # PIL-Pfad
            return buf.getvalue()
        except TypeError:
            pass  # GeneratedImage.save kennt kein format=
    # GeneratedImage: über Tempdatei
    import tempfile
    tmp = os.path.join(tempfile.gettempdir(), f"imggen_{os.getpid()}_{int(time.time()*1000)}.png")
    result.save(tmp)
    with open(tmp, "rb") as f:
        data = f.read()
    try:
        os.remove(tmp)
    except OSError:
        pass
    return data


def _inpaint(model, *, seed, prompt, negative, steps, width, height, ref_path, mask_path):
    """Masken-Inpainting (RePaint) für Z-Image.

    Der MARKIERTE Bereich (Maske weiß) wird frisch aus Rauschen erzeugt; der Rest
    wird bei JEDEM Denoise-Schritt aufs Original-Latent gepinnt. Danach harter
    Pixel-Composite → außerhalb der (weich auslaufenden) Maske bleibt das Bild
    GARANTIERT pixelidentisch (Personen/Gesichter unverändert). Nur Z-Image, lokal.
    """
    import numpy as np
    import mlx.core as mx
    from PIL import Image, ImageFilter
    from mflux.models.common.config.config import Config
    from mflux.models.common.latent_creator.latent_creator import LatentCreator
    from mflux.models.z_image.latent_creator import ZImageLatentCreator
    from mflux.utils.image_util import ImageUtil

    config = Config(
        width=width, height=height, guidance=0.0, scheduler="linear",
        image_path=None, image_strength=None,
        model_config=model.model_config, num_inference_steps=steps,
    )
    sigmas = config.scheduler.sigmas          # Länge n+1, endet bei 0
    n = config.num_inference_steps

    # Original → sauberes, gepacktes Latent + FIXES Rauschen (RePaint: festes Rauschen)
    encoded = LatentCreator.encode_image(
        vae=model.vae, image_path=ref_path, height=height, width=width,
        tiling_config=model.tiling_config,
    )
    clean = ZImageLatentCreator.pack_latents(encoded, height, width)   # [16,1,h,w]
    noise = ZImageLatentCreator.create_noise(seed, height, width)      # [16,1,h,w]

    # Maske → Latent-Auflösung [1,1,h,w]: 1 = ändern (markiert), 0 = behalten
    h_lat, w_lat = height // 8, width // 8
    m_small = Image.open(mask_path).convert("L").resize((w_lat, h_lat), Image.BILINEAR)
    m = mx.array(np.asarray(m_small, dtype=np.float32) / 255.0)
    m = m.reshape(1, 1, h_lat, w_lat).astype(clean.dtype)

    def noised_clean(sig):
        return LatentCreator.add_noise_by_interpolation(clean=clean, noise=noise, sigma=float(sig))

    # Init: markiert = reines Rauschen, Rest = verrauschtes Original bei sigma[0]
    latents = m * noise + (1.0 - m) * noised_clean(sigmas[0])
    text_encodings, negative_encodings = model._encode_prompts(
        prompt=prompt, negative_prompt=negative, guidance=config.guidance,
    )
    predict = model._predict(model.transformer)

    for t in range(n):
        sigma_t = sigmas[t].reshape((1,))
        timestep = mx.ones_like(sigma_t) - sigma_t
        noise_pred = predict(
            latents=latents, timestep=timestep, sigmas=sigmas,
            text_encodings=text_encodings, negative_encodings=negative_encodings,
            guidance=config.guidance,
        )
        latents = config.scheduler.step(noise=noise_pred, timestep=t, latents=latents)
        # Rest auf Original pinnen (Rauschpegel des nächsten Schritts; letzter = 0 → exakt clean)
        latents = m * latents + (1.0 - m) * noised_clean(sigmas[t + 1])
        mx.eval(latents)

    decoded = model._decode_latents(latents=latents, config=config)
    gen = ImageUtil.to_image(
        decoded_latents=decoded, config=config, seed=seed, prompt=prompt,
        quantization=model.bits, lora_paths=model.lora_paths, lora_scales=model.lora_scales,
        image_path=None, image_strength=None, generation_time=0.0, negative_prompt=negative,
    ).image.convert("RGB")

    # Harter Pixel-Composite: außerhalb der gefeatherten Maske EXAKT das Original.
    orig = ImageUtil.scale_to_dimensions(
        image=ImageUtil.load_image(ref_path).convert("RGB"),
        target_width=width, target_height=height,
    ).convert("RGB")
    blur = max(2, width // 200)
    m_full = (
        Image.open(mask_path).convert("L").resize((width, height), Image.BILINEAR)
        .filter(ImageFilter.GaussianBlur(blur))
    )
    mfa = (np.asarray(m_full, dtype=np.float32) / 255.0)[..., None]
    out = np.asarray(gen, dtype=np.float32) * mfa + np.asarray(orig, dtype=np.float32) * (1.0 - mfa)
    return Image.fromarray(np.clip(out, 0.0, 255.0).astype(np.uint8))


def generate(params):
    name = params.get("model", "turbo")
    if name not in MODELS:
        raise ValueError(f"Unbekanntes Modell '{name}'. Erlaubt: {list(MODELS)}")
    if not _is_cached(MODELS[name]["repo"]):
        raise ValueError(f"Modell '{name}' ist (noch) nicht verfügbar.")
    cfg = MODELS[name]
    prompt = (params.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("prompt erforderlich")
    if len(prompt) > 2000:
        prompt = prompt[:2000]
    steps = params.get("steps")
    try:
        steps = int(steps) if steps is not None else cfg["steps"]
    except (TypeError, ValueError):
        steps = cfg["steps"]
    steps = max(1, min(cfg["max_steps"], steps))
    width = _round16(params.get("width", 1024))
    height = _round16(params.get("height", 1024))
    guidance = params.get("guidance", cfg["guidance"])
    negative = params.get("negative_prompt") or None
    seed = params.get("seed")
    if seed is None:
        seed = random.randint(1, 2_000_000_000)
    else:
        seed = int(seed)

    kwargs = dict(seed=seed, prompt=prompt, num_inference_steps=steps,
                  width=width, height=height, negative_prompt=negative)
    if guidance is not None:
        kwargs["guidance"] = float(guidance)

    # Optional: Referenzbild (base64) und/oder Maske (base64) zum Bearbeiten.
    #  - Referenz + Maske → Masken-Inpainting: nur der markierte Bereich wird neu
    #    erzeugt, der Rest bleibt durch harten Pixel-Composite IDENTISCH.
    #  - nur Referenz → klassisches Bild-zu-Bild (image_strength; höher = näher am Original).
    import tempfile
    ref_path = mask_path = None
    if params.get("reference"):
        ref_path = tempfile.NamedTemporaryFile(suffix=".png", delete=False).name
        with open(ref_path, "wb") as f:
            f.write(base64.b64decode(params["reference"]))
    if params.get("mask") and ref_path:
        mask_path = tempfile.NamedTemporaryFile(suffix=".png", delete=False).name
        with open(mask_path, "wb") as f:
            f.write(base64.b64decode(params["mask"]))
    if ref_path and not mask_path:
        kwargs["image_path"] = ref_path
        st = params.get("image_strength")
        kwargs["image_strength"] = max(0.05, min(0.95, float(st))) if st is not None else 0.45

    def _do():
        model = get_model(name)                      # Laden + Generieren auf demselben (MLX-)Thread
        if mask_path:
            img = _inpaint(model, seed=seed, prompt=prompt, negative=negative,
                           steps=steps, width=width, height=height,
                           ref_path=ref_path, mask_path=mask_path)
        else:
            img = model.generate_image(**kwargs)
        return _to_png_bytes(img)

    try:
        t0 = time.time()
        png = run_on_mlx(_do)                         # serialisiert über den Worker-Thread
    finally:
        for _p in (ref_path, mask_path):
            if _p:
                try:
                    os.remove(_p)
                except OSError:
                    pass
    return {
        "image_base64": base64.b64encode(png).decode("ascii"),
        "model": name, "label": cfg["label"], "seed": seed, "steps": steps,
        "width": width, "height": height, "ms": int((time.time() - t0) * 1000),
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # ruhiger Log
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", "/healthz", ""):
            self._send(200, {
                "status": "ok", "service": "imagegen",
                "loaded": list(_loaded.keys()),
                "models": {k: {"label": v["label"], "steps": v["steps"]} for k, v in available_models().items()},
            })
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") != "/generate":
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._send(400, {"error": "ungültiges JSON"})
            return
        try:
            self._send(200, generate(payload))
        except ValueError as e:
            self._send(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001 — robust bleiben, Fehler als JSON
            print(f"[imagegen] Fehler: {e}", file=sys.stderr, flush=True)
            self._send(500, {"error": f"Generierung fehlgeschlagen: {e}"})


def main():
    # Sicherheitsgurt: Bind NUR an localhost.
    if HOST not in ("127.0.0.1", "localhost", "::1"):
        print(f"[imagegen] VERWEIGERT: HOST={HOST} ist nicht localhost.", file=sys.stderr)
        sys.exit(2)
    # Dedizierter MLX-Worker-Thread (alle Modell-Operationen laufen hier).
    threading.Thread(target=_mlx_worker, daemon=True).start()
    for name in PRELOAD:
        if name in MODELS:
            try:
                run_on_mlx(lambda n=name: get_model(n))
            except Exception as e:  # noqa: BLE001
                print(f"[imagegen] Preload '{name}' fehlgeschlagen: {e}", file=sys.stderr, flush=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[imagegen] bereit auf http://{HOST}:{PORT} (Modelle: {list(MODELS)}, preload: {PRELOAD})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
