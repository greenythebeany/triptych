; electron-builder's default "is the app already running" check pipes
; $INSTDIR through a PowerShell one-liner (Get-CimInstance ... Path.StartsWith).
; $INSTDIR here contains non-ASCII characters (a Slovak/Central-European
; Windows username), and that PowerShell command gets built by NSIS's
; ANSI-processed script layer before nsExec ever launches it — exactly the
; kind of path that can silently corrupt those characters, which broke the
; check for at least one real install (installer insisted the app was still
; running even though it wasn't, per Task Manager).
;
; The plain tasklist/taskkill fallback path in the default macros matches by
; image name only — no path, no PowerShell, nothing for a Unicode username to
; corrupt — so force that path unconditionally instead of trying to detect
; whether PowerShell "works" (the default's own detection can't see the
; specific failure mode above; its availability probe never touches $INSTDIR).
!include "getProcessInfo.nsh"
Var pid

; The default _CHECK_APP_RUNNING macro (allowOnlyOneInstallerInstance.nsh)
; only closes a running instance silently when electron-builder's own
; ${isUpdated} check recognizes this as an update over an existing install;
; otherwise it shows a blocking "please close Triptych first" OK/Cancel
; dialog and just Quits if the app is still running by the time the user
; dismisses it. That detection wasn't reliably kicking in for every install
; here, so closing the running app before upgrading kept requiring a manual
; close first. This drops the ${isUpdated} branch entirely and always just
; closes it ourselves — same graceful-then-forced kill sequence the default
; macro uses for its silent path, just unconditional.
!macro customCheckAppRunning
  Var /GLOBAL IsPowerShellAvailable
  StrCpy $IsPowerShellAvailable 1

  ; Before 2.2 the app was JellyWave.exe; close that one too so an upgrade
  ; over an old install that is still open doesn't hit locked files.
  !insertmacro FIND_PROCESS "JellyWave.exe" $R0
  ${if} $R0 == 0
    !insertmacro KILL_PROCESS "JellyWave.exe" 1
    Sleep 1000
  ${endIf}

  ${GetProcessInfo} 0 $pid $1 $2 $3 $4
  ${if} $3 != "${APP_EXECUTABLE_FILENAME}"
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 == 0
      DetailPrint "$(appClosing)"
      !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 0
      ; give it a moment to exit gracefully before checking again
      Sleep 300

      StrCpy $R1 0
      loop:
        IntOp $R1 $R1 + 1

        !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
        ${if} $R0 == 0
          Sleep 1000
          !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 1 ; 1 = force kill
          !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
          ${if} $R0 == 0
            DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
            Sleep 2000
          ${else}
            Goto not_running
          ${endIf}
        ${else}
          Goto not_running
        ${endIf}

        ; Still running after a forced kill attempt — likely elevated
        ; permissions we can't touch. Only now ask the user to close it
        ; themselves, instead of failing silently.
        ${if} $R1 > 2
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY loop
          Quit
        ${else}
          Goto loop
        ${endIf}
      not_running:
    ${endIf}
  ${endIf}

  ; 2.4.2 shipped the mobile-only Capacitor packages (with Android Gradle
  ; build output) unpacked. Its uninstaller moves every file into Temp before
  ; deleting, and some of those paths pass MAX_PATH there, so it aborts and
  ; the update stops at "can't be closed" -- Retry never helps. This runs
  ; right before the old uninstaller; the desktop app never loads them.
  RMDir /r "$INSTDIR\resources\app.asar.unpacked\node_modules"
!macroend

; Up to 2.2 the app was installed as com.jellywave.app (this GUID). 2.3
; uses com.triptych.app, so Windows sees a different program: uninstall the
; old entry first, silently and keeping the user's data (main.js moves the
; data folder on the first start), so it doesn't stay behind with its own
; Start menu shortcut.
!define LEGACY_APP_GUID "6d2b7fa0-7d48-5e2c-8e0a-9b906aac6cfe"
!macro removeLegacyInstall ROOT
  ReadRegStr $R5 ${ROOT} "Software\${LEGACY_APP_GUID}" "InstallLocation"
  ${if} $R5 != ""
    ${if} ${FileExists} "$R5\Uninstall Triptych.exe"
      ExecWait '"$R5\Uninstall Triptych.exe" /S /KEEP_APP_DATA _?=$R5'
      Delete "$R5\Uninstall Triptych.exe"
    ${elseif} ${FileExists} "$R5\Uninstall JellyWave.exe"
      ExecWait '"$R5\Uninstall JellyWave.exe" /S /KEEP_APP_DATA _?=$R5'
      Delete "$R5\Uninstall JellyWave.exe"
    ${endif}
    RMDir "$R5"
    DeleteRegKey ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\${LEGACY_APP_GUID}"
    DeleteRegKey ${ROOT} "Software\${LEGACY_APP_GUID}"
  ${endif}
!macroend

!macro customInit
  !insertmacro removeLegacyInstall HKCU
  !insertmacro removeLegacyInstall HKLM
!macroend

; Welcome page with the Triptych sidebar art (the assisted installer only
; shows one when this macro exists). Its text is picked at runtime from the
; installer language, in the same 15 languages as the app; English otherwise.
!macro customWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_PRE TriptychWelcomePre
  !define MUI_WELCOMEPAGE_TITLE "$WelcomeTitle"
  !define MUI_WELCOMEPAGE_TEXT "$WelcomeText"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!ifndef BUILD_UNINSTALLER
!include "LogicLib.nsh"
Var WelcomeTitle
Var WelcomeText
Function TriptychWelcomePre
  ${If} $LANGUAGE == 1051
    StrCpy $WelcomeTitle "Vitaj v Triptych"
    StrCpy $WelcomeText "Triptych je hudobný prehrávač pre tvoj vlastný server Jellyfin.$\r$\n$\r$\nNainštaluje sa Triptych ${VERSION}. Ak je otvorená staršia verzia alebo JellyWave, zavrie sa a aktualizuje. Prihlásenie, nastavenia aj štatistiky počúvania ostanú.$\r$\n$\r$\nPokračuj tlačidlom Ďalej."
  ${ElseIf} $LANGUAGE == 1029
    StrCpy $WelcomeTitle "Vítej v Triptych"
    StrCpy $WelcomeText "Triptych je hudební přehrávač pro tvůj vlastní server Jellyfin.$\r$\n$\r$\nNainstaluje se Triptych ${VERSION}. Pokud je otevřená starší verze nebo JellyWave, zavře se a aktualizuje. Přihlášení, nastavení i statistiky poslechu zůstanou.$\r$\n$\r$\nPokračuj tlačítkem Další."
  ${ElseIf} $LANGUAGE == 1031
    StrCpy $WelcomeTitle "Willkommen bei Triptych"
    StrCpy $WelcomeText "Triptych ist ein Musikplayer für deinen eigenen Jellyfin-Server.$\r$\n$\r$\nTriptych ${VERSION} wird jetzt installiert. Ist eine ältere Version oder JellyWave geöffnet, wird sie geschlossen und aktualisiert. Anmeldung, Einstellungen und Hörstatistik bleiben erhalten.$\r$\n$\r$\nKlicke auf Weiter, um fortzufahren."
  ${ElseIf} $LANGUAGE == 1036
    StrCpy $WelcomeTitle "Bienvenue dans Triptych"
    StrCpy $WelcomeText "Triptych est un lecteur de musique pour votre propre serveur Jellyfin.$\r$\n$\r$\nTriptych ${VERSION} va être installé. Si une ancienne version ou JellyWave est ouverte, elle sera fermée et mise à jour. Votre connexion, vos réglages et vos statistiques d'écoute sont conservés.$\r$\n$\r$\nCliquez sur Suivant pour continuer."
  ${ElseIf} $LANGUAGE == 1034
    StrCpy $WelcomeTitle "Te damos la bienvenida a Triptych"
    StrCpy $WelcomeText "Triptych es un reproductor de música para tu propio servidor Jellyfin.$\r$\n$\r$\nSe instalará Triptych ${VERSION}. Si hay una versión anterior o JellyWave abierta, se cerrará y se actualizará. Tu sesión, ajustes y estadísticas de escucha se conservan.$\r$\n$\r$\nHaz clic en Siguiente para continuar."
  ${ElseIf} $LANGUAGE == 1040
    StrCpy $WelcomeTitle "Benvenuto in Triptych"
    StrCpy $WelcomeText "Triptych è un lettore musicale per il tuo server Jellyfin.$\r$\n$\r$\nVerrà installato Triptych ${VERSION}. Se è aperta una versione precedente o JellyWave, verrà chiusa e aggiornata. Accesso, impostazioni e statistiche di ascolto restano.$\r$\n$\r$\nFai clic su Avanti per continuare."
  ${ElseIf} $LANGUAGE == 1043
    StrCpy $WelcomeTitle "Welkom bij Triptych"
    StrCpy $WelcomeText "Triptych is een muziekspeler voor je eigen Jellyfin-server.$\r$\n$\r$\nTriptych ${VERSION} wordt geïnstalleerd. Is een oudere versie of JellyWave geopend, dan wordt die gesloten en bijgewerkt. Je login, instellingen en luisterstatistieken blijven bewaard.$\r$\n$\r$\nKlik op Volgende om door te gaan."
  ${ElseIf} $LANGUAGE == 1045
    StrCpy $WelcomeTitle "Witaj w Triptych"
    StrCpy $WelcomeText "Triptych to odtwarzacz muzyki dla Twojego własnego serwera Jellyfin.$\r$\n$\r$\nZostanie zainstalowany Triptych ${VERSION}. Jeśli otwarta jest starsza wersja lub JellyWave, zostanie zamknięta i zaktualizowana. Logowanie, ustawienia i statystyki słuchania zostają.$\r$\n$\r$\nKliknij Dalej, aby kontynuować."
  ${ElseIf} $LANGUAGE == 1030
    StrCpy $WelcomeTitle "Velkommen til Triptych"
    StrCpy $WelcomeText "Triptych er en musikafspiller til din egen Jellyfin-server.$\r$\n$\r$\nTriptych ${VERSION} bliver installeret. Hvis en ældre version eller JellyWave er åben, lukkes og opdateres den. Dit login, dine indstillinger og din lyttestatistik bevares.$\r$\n$\r$\nKlik på Næste for at fortsætte."
  ${ElseIf} $LANGUAGE == 1053
    StrCpy $WelcomeTitle "Välkommen till Triptych"
    StrCpy $WelcomeText "Triptych är en musikspelare för din egen Jellyfin-server.$\r$\n$\r$\nTriptych ${VERSION} installeras. Om en äldre version eller JellyWave är öppen stängs den och uppdateras. Din inloggning, dina inställningar och din lyssningsstatistik finns kvar.$\r$\n$\r$\nKlicka på Nästa för att fortsätta."
  ${ElseIf} $LANGUAGE == 1044
    StrCpy $WelcomeTitle "Velkommen til Triptych"
    StrCpy $WelcomeText "Triptych er en musikkspiller for din egen Jellyfin-server.$\r$\n$\r$\nTriptych ${VERSION} blir installert. Hvis en eldre versjon eller JellyWave er åpen, blir den lukket og oppdatert. Innloggingen, innstillingene og lyttestatistikken din beholdes.$\r$\n$\r$\nKlikk Neste for å fortsette."
  ${ElseIf} $LANGUAGE == 1035
    StrCpy $WelcomeTitle "Tervetuloa Triptychiin"
    StrCpy $WelcomeText "Triptych on musiikkisoitin omalle Jellyfin-palvelimellesi.$\r$\n$\r$\nTriptych ${VERSION} asennetaan. Jos vanhempi versio tai JellyWave on auki, se suljetaan ja päivitetään. Kirjautumisesi, asetuksesi ja kuuntelutilastosi säilyvät.$\r$\n$\r$\nJatka valitsemalla Seuraava."
  ${ElseIf} $LANGUAGE == 1049
    StrCpy $WelcomeTitle "Добро пожаловать в Triptych"
    StrCpy $WelcomeText "Triptych — музыкальный плеер для вашего собственного сервера Jellyfin.$\r$\n$\r$\nБудет установлен Triptych ${VERSION}. Если открыта старая версия или JellyWave, она будет закрыта и обновлена. Вход, настройки и статистика прослушивания сохранятся.$\r$\n$\r$\nНажмите «Далее», чтобы продолжить."
  ${ElseIf} $LANGUAGE == 1058
    StrCpy $WelcomeTitle "Ласкаво просимо до Triptych"
    StrCpy $WelcomeText "Triptych — музичний плеєр для вашого власного сервера Jellyfin.$\r$\n$\r$\nБуде встановлено Triptych ${VERSION}. Якщо відкрита старіша версія або JellyWave, її буде закрито й оновлено. Вхід, налаштування та статистика прослуховування збережуться.$\r$\n$\r$\nНатисніть «Далі», щоб продовжити."
  ${Else}
    StrCpy $WelcomeTitle "Welcome to Triptych"
    StrCpy $WelcomeText "Triptych is a music player for your own Jellyfin server.$\r$\n$\r$\nThis will install Triptych ${VERSION}. If an older version or JellyWave is open, it will be closed and updated. Your login, settings and listening stats are kept.$\r$\n$\r$\nClick Next to continue."
  ${EndIf}
FunctionEnd
!endif
