; AdaptiveAIStudio — Windows インストーラ
;
; 置き場所の考え方
;
;   Program Files\AdaptiveAIStudio\   プログラム本体（書き換えない）
;   ProgramData\AdaptiveAIStudio\     設定・記録・モデル（書き換える）
;
; データを ProgramData に置くのは理由がある。普通なら LocalAppData だが、
; そこは C:\Users\<利用者名>\AppData\Local で、**利用者名が全角だと
; llama.cpp がモデルを開けない**。ProgramData は必ず ASCII なので、
; この一点のためにこちらを使う。
;
; アンインストールはコントロールパネルから。
; 消し損ねてもフォルダごと削除すれば済むよう、レジストリには
; アンインストール情報しか書かない。

Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"

!define APP    "AdaptiveAIStudio"
!define PUB    "Maguro-JP"
!ifndef VERSION
  !define VERSION "0.0.0"
!endif

Name "${APP}"
OutFile "${APP}-Setup.exe"
InstallDir "$PROGRAMFILES64\${APP}"
InstallDirRegKey HKLM "Software\${APP}" "InstallDir"
RequestExecutionLevel admin
SetCompressor /SOLID lzma

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Japanese"
!insertmacro MUI_LANGUAGE "English"

Section "install"
  SetOutPath "$INSTDIR"

  ; 中身。payload\ は CI が組み立てたもの。
  File /r "payload\*.*"

  ; データの置き場。ここだけは利用者が書ける必要がある。
  ; 差し込みで権限を付ける（外部プラグインに頼らない）。
  ; S-1-5-32-545 は Users 群の番号。日本語の Windows では名前が
  ; 「ユーザー」になるので、**名前ではなく番号で指す**。
  CreateDirectory "$COMMONPROGRAMDATA\${APP}"

  ; モデルの保存先は、自作アプリどうしで共有する C:\LLM\gguf（.claude/skills/shared-models）。
  ; 数 GB のモデルをアプリごとに持たない。入れるときに作り、何を置くのかもその場に書いておく。
  ; ほかのアプリが先に作っていれば、説明は書き換えない。消すときも、ここは消さない（共有の保存先のため）。
  StrCpy $1 $WINDIR 2
  CreateDirectory "$1\LLM\gguf"
  CreateDirectory "$1\LLM\huggingface"
  IfFileExists "$1\LLM\README.txt" llmReadmeDone
  FileOpen $0 "$1\LLM\README.txt" w
  ; メモ帳が CP932 として読まないよう、先頭に印を書く。
  FileWriteWord $0 65279
  FileWriteUTF16LE $0 "自作アプリどうしで共有する AI のモデルの保存先です。$\r$\n"
  FileWriteUTF16LE $0 "$\r$\n"
  FileWriteUTF16LE $0 "  gguf\         言葉のモデル（.gguf）。${APP} はここを読みます$\r$\n"
  FileWriteUTF16LE $0 "  huggingface\  Hugging Face の形のままのモデル$\r$\n"
  FileWriteUTF16LE $0 "$\r$\n"
  FileWriteUTF16LE $0 "gguf に .gguf のファイルを1つ置くと読みます。${APP} の画面からも取ってこられます。$\r$\n"
  FileWriteUTF16LE $0 "大きさの目安: 8GB の機械なら 3B〜4B の Q4_K_M（2GB 前後）。$\r$\n"
  FileWriteUTF16LE $0 "ほかのアプリも使うので、このフォルダはアンインストールしても消えません。$\r$\n"
  FileClose $0
  llmReadmeDone:
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$1\LLM" /grant *S-1-5-32-545:(OI)(CI)M /T'

  ; 権限は、置き場を作ってから一度で付ける（/T で下まで）。
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$COMMONPROGRAMDATA\${APP}" /grant *S-1-5-32-545:(OI)(CI)M /T'

  ; 入口。データの置き場をここで決めて渡す。
  ; プログラム側に「インストール済みかどうか」を判断させない。
  ; 決めるのは入れた側で、使う側は渡されたところを使うだけ。
  FileOpen $0 "$INSTDIR\${APP}.cmd" w
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 'set "AAS_HOME=$COMMONPROGRAMDATA\${APP}"$\r$\n'
  ; 何も渡さずに押されたら、画面をアプリのウィンドウで開く（黒いコンソールは最小化して下に置く）。
  ; 番号で選ぶ一覧は  ${APP}.cmd menu  で出る。中身は launcher.cmd と同じ分かれ方。
  FileWrite $0 'if "%~1"=="" goto :window$\r$\n'
  FileWrite $0 'if /i "%~1"=="menu" goto :menu$\r$\n'
  FileWrite $0 'call "%~dp0app\start.cmd" %*$\r$\n'
  FileWrite $0 'exit /b$\r$\n'
  FileWrite $0 ':window$\r$\n'
  FileWrite $0 'start "${APP}" /min cmd /c ""%~dp0app\start.cmd" ui"$\r$\n'
  FileWrite $0 'exit /b$\r$\n'
  FileWrite $0 ':menu$\r$\n'
  FileWrite $0 'call "%~dp0app\start.cmd"$\r$\n'
  FileClose $0

  ; ショートカット。デスクトップとスタートメニューに1つずつ。
  ; 絵柄はまだ用意していない。無いものを指すと、既定の絵柄すら出ないことがある。
  ; 押すとアプリのウィンドウが開く。入口の黒いコンソールは最小化して出す（一瞬映らないように）。
  CreateShortcut "$DESKTOP\${APP}.lnk" "$INSTDIR\${APP}.cmd" "" "" "" SW_SHOWMINIMIZED
  CreateDirectory "$SMPROGRAMS\${APP}"
  CreateShortcut "$SMPROGRAMS\${APP}\${APP}.lnk" "$INSTDIR\${APP}.cmd" "" "" "" SW_SHOWMINIMIZED
  CreateShortcut "$SMPROGRAMS\${APP}\アンインストール.lnk" "$INSTDIR\Uninstall.exe"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; コントロールパネルに出す。
  !define UNINST "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}"
  WriteRegStr   HKLM "${UNINST}" "DisplayName"     "${APP}"
  WriteRegStr   HKLM "${UNINST}" "DisplayVersion"  "${VERSION}"
  WriteRegStr   HKLM "${UNINST}" "Publisher"       "${PUB}"
  WriteRegStr   HKLM "${UNINST}" "InstallLocation" "$INSTDIR"
  WriteRegStr   HKLM "${UNINST}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKLM "${UNINST}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKLM "${UNINST}" "EstimatedSize" "$0"
  WriteRegStr   HKLM "Software\${APP}" "InstallDir" "$INSTDIR"
SectionEnd

Section "uninstall"
  ; プログラムは消す。
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\runtime"
  Delete "$INSTDIR\${APP}.cmd"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\VERSION"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  Delete "$DESKTOP\${APP}.lnk"
  RMDir /r "$SMPROGRAMS\${APP}"

  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}"
  DeleteRegKey HKLM "Software\${APP}"

  ; **モデルは消さない。**数GB を落とし直させることになるうえ、
  ; 入れ直すつもりで消した人が、次に困る。
  ; 消したい人向けに、場所と、消す前に写しを取ることを伝える（会話・設定・記憶も同じ場所にあり、消すと戻らない）。
  MessageBox MB_OK|MB_ICONINFORMATION \
    "アンインストールしました。$\r$\n$\r$\nモデルと記録は残してあります（数GBあるため）。$\r$\nいらない場合は、このフォルダごと削除できます。会話・設定・記憶も入っているので、$\r$\n残したいものがあれば、先に別の場所へ写しを取ってください:$\r$\n$COMMONPROGRAMDATA\${APP}"
SectionEnd
