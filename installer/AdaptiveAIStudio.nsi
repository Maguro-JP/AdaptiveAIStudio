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

  ; モデルの置き場は、**入れるときに作る。**
  ; 「GGUF を1つ置くだけ」と案内しておいて置き場が無いのでは、案内にならない。
  ; 何を置くのかも、その場に書いておく（設定画面まで辿り着けない人がいる）。
  CreateDirectory "$COMMONPROGRAMDATA\${APP}\models"
  FileOpen $0 "$COMMONPROGRAMDATA\${APP}\models\README.txt" w
  ; メモ帳が CP932 として読まないよう、先頭に印を書く。
  FileWriteWord $0 65279
  FileWriteUTF16LE $0 "このフォルダに .gguf のファイルを1つ置くと、${APP} がそれを読みます。$\r$\n"
  FileWriteUTF16LE $0 "$\r$\n"
  FileWriteUTF16LE $0 "取ってくる先の例:$\r$\n"
  FileWriteUTF16LE $0 "  https://huggingface.co/Qwen （名前に GGUF が付いたもの）$\r$\n"
  FileWriteUTF16LE $0 "$\r$\n"
  FileWriteUTF16LE $0 "大きさの目安: 8GB の機械なら 3B〜4B の Q4_K_M（2GB 前後）。$\r$\n"
  FileWriteUTF16LE $0 "記憶より大きいものは読めません。読む前に止めて、そう言います。$\r$\n"
  FileWriteUTF16LE $0 "$\r$\n"
  FileWriteUTF16LE $0 "置いたあと、${APP} を開き直すか、設定 → モデル で選び直してください。$\r$\n"
  FileClose $0

  ; 権限は、置き場を作ってから一度で付ける（/T で下まで）。
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$COMMONPROGRAMDATA\${APP}" /grant *S-1-5-32-545:(OI)(CI)M /T'

  ; 入口。データの置き場をここで決めて渡す。
  ; プログラム側に「インストール済みかどうか」を判断させない。
  ; 決めるのは入れた側で、使う側は渡されたところを使うだけ。
  FileOpen $0 "$INSTDIR\${APP}.cmd" w
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 'set "AAS_HOME=$COMMONPROGRAMDATA\${APP}"$\r$\n'
  FileWrite $0 'call "%~dp0app\start.cmd" %*$\r$\n'
  FileClose $0

  ; ショートカット。デスクトップとスタートメニューに1つずつ。
  ; 絵柄はまだ用意していない。無いものを指すと、既定の絵柄すら出ないことがある。
  CreateShortcut "$DESKTOP\${APP}.lnk" "$INSTDIR\${APP}.cmd"
  CreateDirectory "$SMPROGRAMS\${APP}"
  CreateShortcut "$SMPROGRAMS\${APP}\${APP}.lnk" "$INSTDIR\${APP}.cmd"
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
  ; 消したい人向けに、場所だけ伝える。
  MessageBox MB_OK|MB_ICONINFORMATION \
    "アンインストールしました。$\r$\n$\r$\nモデルと記録は残してあります（数GBあるため）。$\r$\nいらない場合は、このフォルダごと削除してください:$\r$\n$COMMONPROGRAMDATA\${APP}"
SectionEnd
