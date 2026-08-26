import { defineDict } from '../types';

// Allgemeine Beschriftungen, die überall vorkommen. Neue Bereiche bekommen ein
// eigenes Wörterbuch daneben (siehe i18n/index.ts).

export const common = defineDict(
  {
    // --- Aktionen ------------------------------------------------------------
    'aktion.speichern': 'Speichern',
    'aktion.abbrechen': 'Abbrechen',
    'aktion.loeschen': 'Löschen',
    'aktion.schliessen': 'Schließen',
    'aktion.zurueck': 'Zurück',
    'aktion.weiter': 'Weiter',
    'aktion.anlegen': 'Anlegen',
    'aktion.bearbeiten': 'Bearbeiten',
    'aktion.suchen': 'Suchen',
    'aktion.herunterladen': 'Herunterladen',
    'aktion.hochladen': 'Hochladen',
    'aktion.antworten': 'Antworten',

    // --- Zustände ------------------------------------------------------------
    'zustand.laedt': 'Wird geladen …',
    'zustand.gespeichert': 'Gespeichert',
    'zustand.keineDaten': 'Noch nichts vorhanden',
    'zustand.fehler': 'Es ist ein Fehler aufgetreten',
    'zustand.nichtErreichbar': 'Server nicht erreichbar',

    // --- Anmeldung -----------------------------------------------------------
    'anmeldung.titel': 'Anmelden',
    'anmeldung.hinweis': 'Mit Ihrem Active-Directory-Konto. Benutzername oder E-Mail.',
    'anmeldung.benutzer': 'Benutzername oder E-Mail',
    'anmeldung.passwort': 'Passwort',
    'anmeldung.zeigen': 'Zeigen',
    'anmeldung.verbergen': 'Verbergen',
    'anmeldung.absenden': 'Anmelden',
    'anmeldung.fuss': 'Interner Dienst · nur im Firmennetz erreichbar',
    'anmeldung.abmelden': 'Abmelden',

    // --- Bereiche ------------------------------------------------------------
    'bereich.chat': 'Chat',
    'bereich.neuerChat': 'Neuer Chat',
    'bereich.projekte': 'Projekte',
    'bereich.vault': 'Wissens-Vault',
    'bereich.dateien': 'Dateien',
    'bereich.etiketten': 'Etiketten',
    'bereich.bilder': 'Bildgenerierung',
    'bereich.verwaltung': 'Administration',
    'bereich.rueckmeldung': 'Feedback geben',

    // --- Unternehmens-Konfiguration ------------------------------------------
    'org.titel': 'Unternehmen',
    'org.hinweis':
      'Name, Betreiber, Farbe und Sprache dieser Installation. Gilt für alle Benutzer und wirkt sofort — ein Neustart ist nicht nötig.',
    'org.appName': 'Name der Anwendung',
    'org.appNameHilfe': 'Erscheint im Titel, in der Kopfzeile und auf erzeugten Dokumenten.',
    'org.appShort': 'Kurzform',
    'org.appShortHilfe': 'Für enge Stellen. Leer lassen heißt: wie der volle Name.',
    'org.organisation': 'Betreiber',
    'org.organisationHilfe': 'Erscheint auf erzeugten Dokumenten. Leer lassen ist erlaubt.',
    'org.farbe': 'Markenfarbe',
    'org.farbeHilfe': 'Hex-Wert, z. B. #2563eb.',
    'org.sprache': 'Sprache der Oberfläche',
    'org.spracheHilfe':
      'Gilt für die gesamte Installation, nicht je Benutzer: Beschriftungen, über die man sich verständigt, sollen bei allen gleich heißen.',
    'org.farbeUngueltig': 'Die Farbe muss als Hex-Wert angegeben werden, z. B. #2563eb.',
    'org.nameLeer': 'Der Name der Anwendung darf nicht leer sein.',
  },
  {
    'aktion.speichern': 'Save',
    'aktion.abbrechen': 'Cancel',
    'aktion.loeschen': 'Delete',
    'aktion.schliessen': 'Close',
    'aktion.zurueck': 'Back',
    'aktion.weiter': 'Next',
    'aktion.anlegen': 'Create',
    'aktion.bearbeiten': 'Edit',
    'aktion.suchen': 'Search',
    'aktion.herunterladen': 'Download',
    'aktion.hochladen': 'Upload',
    'aktion.antworten': 'Reply',

    'zustand.laedt': 'Loading …',
    'zustand.gespeichert': 'Saved',
    'zustand.keineDaten': 'Nothing here yet',
    'zustand.fehler': 'Something went wrong',
    'zustand.nichtErreichbar': 'Server unreachable',

    'anmeldung.titel': 'Sign in',
    'anmeldung.hinweis': 'With your Active Directory account. Username or email.',
    'anmeldung.benutzer': 'Username or email',
    'anmeldung.passwort': 'Password',
    'anmeldung.zeigen': 'Show',
    'anmeldung.verbergen': 'Hide',
    'anmeldung.absenden': 'Sign in',
    'anmeldung.fuss': 'Internal service · reachable on the company network only',
    'anmeldung.abmelden': 'Sign out',

    'bereich.chat': 'Chat',
    'bereich.neuerChat': 'New chat',
    'bereich.projekte': 'Projects',
    'bereich.vault': 'Knowledge vault',
    'bereich.dateien': 'Files',
    'bereich.etiketten': 'Labels',
    'bereich.bilder': 'Image generation',
    'bereich.verwaltung': 'Administration',
    'bereich.rueckmeldung': 'Give feedback',

    'org.titel': 'Organisation',
    'org.hinweis':
      'Name, operator, colour and language of this installation. Applies to every user and takes effect immediately — no restart needed.',
    'org.appName': 'Application name',
    'org.appNameHilfe': 'Shown in the title, the header and on generated documents.',
    'org.appShort': 'Short form',
    'org.appShortHilfe': 'For tight spots. Leave empty to use the full name.',
    'org.organisation': 'Operator',
    'org.organisationHilfe': 'Shown on generated documents. May be left empty.',
    'org.farbe': 'Brand colour',
    'org.farbeHilfe': 'Hex value, e.g. #2563eb.',
    'org.sprache': 'Interface language',
    'org.spracheHilfe':
      'Applies to the whole installation, not per user: labels people refer to in conversation should read the same for everyone.',
    'org.farbeUngueltig': 'The colour must be a hex value, e.g. #2563eb.',
    'org.nameLeer': 'The application name must not be empty.',
  },
);
