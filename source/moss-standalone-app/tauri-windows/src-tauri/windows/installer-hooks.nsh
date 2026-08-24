; Tauri already checks moss-desk-pet-tauri.exe, restores the previous $INSTDIR
; from the registry, and offers to close the process before replacing files.
; Keep compatibility with the former Electron portable process name as well.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "MOSS-Desk-Pet.exe" "MOSS Desk Pet"
!macroend
