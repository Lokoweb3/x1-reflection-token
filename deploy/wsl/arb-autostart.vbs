' Keeps the arb bot up on this Windows machine: copy into the Startup folder (Win+R, shell:startup).
' At logon it starts WSL (hidden) running scripts/arb-watchdog.sh, which starts the bot; if WSL shuts
' down (wsl --shutdown, an update, a crash) it starts it again 30 seconds later.
Set sh = CreateObject("WScript.Shell")
Do
  sh.Run "wsl.exe -d Ubuntu -u steven -- /home/steven/X1_PROJECTS/REFLECTION_TOKEN/scripts/arb-watchdog.sh", 0, True
  WScript.Sleep 30000
Loop
