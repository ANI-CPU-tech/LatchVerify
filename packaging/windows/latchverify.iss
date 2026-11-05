; LatchVerify installer (Inno Setup 6). Built by .github/workflows/build-installers.yml:
;
;   ISCC /DAppVersion=1.2.3 /DFileVersion=1.2.3.0 /DStageDir=<stage> /DOutputDir=<out> packaging\windows\latchverify.iss
;
; <stage> holds app\ (packaging/stage.ts), node\ (fetch-node.ps1) and desktop\ (packaging/build-desktop.ts). Add /DSignTool=1 together with
; /Slatchsign=<command> to Authenticode-sign the installer and uninstaller. Add /DWizardArtDir=<dir> after
; `tsx packaging/windows/wizard-art.ts <dir>` for the LatchVerify look (Inno Setup 6.6 or newer): the app's
; landscape behind the whole wizard and the app's own buttons, in Default Light's colors in Windows light
; mode and Terminal Dark's in dark mode. Without it the wizard has the stock look.
;
; Per-user install: no administrator rights, nothing written outside the user's profile. Installing
; connects no MCP client unless the user ticks that task or passes /TASKS=linkclients, as on Linux; an
; update the app runs (/RELAUNCH=1) never does, so a client the user disconnected stays disconnected.
; A linked client's MCP servers start behind the latch proxy, with their tools pinned in
; %APPDATA%\LatchVerify\latch.lock. Before uninstalling it unlinks them all (`latch setup --remove --all`);
; latch.lock is kept, so a reinstall keeps the approvals. The LatchVerify app (desktop\) starts after
; installing, sits in the tray and starts at login; uninstalling stops it and removes its login start.

#ifndef AppVersion
  #error Pass /DAppVersion=x.y.z (package.json's version)
#endif
#ifndef FileVersion
  #error Pass /DFileVersion=x.y.z.0
#endif
#ifndef StageDir
  #error Pass /DStageDir=<directory holding app\ and node\>
#endif
#ifndef OutputDir
  #define OutputDir "out"
#endif
#define RepoDir AddBackslash(SourcePath) + "..\.."

[Setup]
AppId={{6B1E8E57-3C55-4D8B-9A7F-1D2C5E0B9F31}
AppName=LatchVerify
AppVersion={#AppVersion}
AppVerName=LatchVerify {#AppVersion}
AppPublisher=LatchVerify contributors
AppPublisherURL=https://github.com/ANI-CPU-tech/LatchVerify
AppSupportURL=https://github.com/ANI-CPU-tech/LatchVerify/issues
AppUpdatesURL=https://github.com/ANI-CPU-tech/LatchVerify/releases
VersionInfoVersion={#FileVersion}
VersionInfoProductVersion={#FileVersion}
VersionInfoDescription=LatchVerify installer
DefaultDirName={autopf}\LatchVerify
DefaultGroupName=LatchVerify
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
ChangesEnvironment=yes
; Claude Code keeps the bundled node.exe busy while its servers run; offer to close them on upgrade.
CloseApplications=yes
; A user's earlier tick must not link clients again on the next install.
UsePreviousTasks=no
LicenseFile={#RepoDir}\LICENSE
SetupIconFile=latchverify.ico
UninstallDisplayIcon={app}\latchverify.ico
UninstallDisplayName=LatchVerify
OutputDir={#OutputDir}
OutputBaseFilename=latchverify-{#AppVersion}-windows-x64-setup
Compression=lzma2/max
SolidCompression=yes
#if defined(WizardArtDir) && Ver >= EncodeVer(6,6,0)
#define ThemedWizard
; Follows Windows light or dark mode: the theme's background color, the landscape behind every page
; (no left-hand image), the padlock top right, and the app's buttons ([Code] below).
WizardStyle=modern dynamic windows11 hidebevels
DisableWelcomePage=no
#include AddBackslash(WizardArtDir) + "wizard-art.iss"
#include AddBackslash(WizardArtDir) + "wizard-art-dark.iss"
#else
WizardStyle=modern
#endif
#ifdef SignTool
SignTool=latchsign
SignedUninstaller=yes
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
WelcomeLabel1=Welcome to LatchVerify
WelcomeLabel2=LatchVerify keeps your MCP servers honest: it pins each tool's capabilities and holds any tool that gains new ones until you review it.%n%nIt installs for you alone, with no administrator rights, and connects no MCP client unless you choose to.
FinishedHeadingLabel=LatchVerify is installed

[Tasks]
Name: linkclients; Description: "Link every MCP client found now (Claude Code, Cursor, VS Code and others): their servers start behind latch and their tools are pinned in your latch.lock. You can also choose later with latch setup, or in the LatchVerify app."; Flags: unchecked
Name: addtopath; Description: "Add latch to PATH for new terminals"

[InstallDelete]
; Files from an older version that the new one no longer ships.
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\desktop"

[Files]
Source: "{#StageDir}\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\node\*"; DestDir: "{app}\node"; Flags: ignoreversion recursesubdirs
Source: "{#StageDir}\desktop\*"; DestDir: "{app}\desktop"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "latch.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "latchverify.ico"; DestDir: "{app}"; Flags: ignoreversion
; How `latch update` and the app install updates (src/update): with this installer.
Source: "install-kind"; DestDir: "{app}"; Flags: ignoreversion
#ifdef ThemedWizard
; The button images [Code] draws; extracted to {tmp} while Setup runs, never installed.
#include AddBackslash(WizardArtDir) + "wizard-files.iss"
#endif

[Icons]
Name: "{group}\LatchVerify"; Filename: "{app}\desktop\latchverify-desktop.exe"; IconFilename: "{app}\latchverify.ico"; Comment: "Keep your MCP clients behind LatchVerify and review tool changes"; AppUserModelID: "io.github.ANI-CPU-tech.LatchVerify"
Name: "{group}\Uninstall LatchVerify"; Filename: "{uninstallexe}"

[Registry]
; The app's login start (src/desktop/main.ts writes it under this name); removed with the app.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "io.github.ANI-CPU-tech.LatchVerify"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}"; Tasks: addtopath; Check: NeedsAddPath(ExpandConstant('{app}'))

[Run]
Filename: "{app}\desktop\latchverify-desktop.exe"; Description: "Start LatchVerify"; Flags: nowait postinstall skipifsilent
; After a silent update the app installed (src/update passes /RELAUNCH=1), start it again in the tray.
Filename: "{app}\desktop\latchverify-desktop.exe"; Parameters: "--hidden"; Flags: nowait; Check: RelaunchRequested

[UninstallDelete]
Type: files; Name: "{app}\setup.log"

[Code]
const
  EnvKey = 'Environment';

#ifdef ThemedWizard
{ The app's buttons (buttonClass in web/src/components/ui.tsx) drawn over the wizard's own: Next as the
  primary button, Back and Cancel as secondary ones, each with hover and disabled faces. The wizard's
  buttons move out of sight but keep working, so Enter and Esc still press them; a timer copies their
  caption, state and visibility onto the drawn ones, and follows the mouse for the hover face. }
type
  TThemedButton = record
    Real: TNewButton;
    Kind: String;
    X, Y, W, H: Integer;
    Normal, Hover, Disabled: TBitmapImage;
    Text: TLabel;
  end;
  TCursorPoint = record
    X, Y: Longint;
  end;

const
  OffScreen = -10000;

var
  ThemedButtons: array of TThemedButton;

function SetTimer(hWnd: HWND; nIDEvent: UINT_PTR; uElapse: UINT; lpTimerFunc: LongWord): UINT_PTR; { LongWord: Inno Setup 6.6 lacks the newer pointer-sized type, and this Setup is 32-bit }
  external 'SetTimer@user32.dll stdcall';
function GetCursorPos(var Point: TCursorPoint): BOOL;
  external 'GetCursorPos@user32.dll stdcall';
function ScreenToClient(hWnd: HWND; var Point: TCursorPoint): BOOL;
  external 'ScreenToClient@user32.dll stdcall';

function ThemeMode: String;
begin
  if IsDarkInstallMode then
    Result := 'dark'
  else
    Result := 'light';
end;

{ The label color packaging/windows/wizard-art.ts wrote for this kind of button, in this mode. }
function ButtonTextColor(Kind: String; Enabled: Boolean): TColor;
begin
  if IsDarkInstallMode then
  begin
    if Kind = 'primary' then
    begin
      if Enabled then Result := {#ButtonText_primary_normal_dark}
      else Result := {#ButtonText_primary_disabled_dark};
    end else begin
      if Enabled then Result := {#ButtonText_secondary_normal_dark}
      else Result := {#ButtonText_secondary_disabled_dark};
    end;
  end else begin
    if Kind = 'primary' then
    begin
      if Enabled then Result := {#ButtonText_primary_normal_light}
      else Result := {#ButtonText_primary_disabled_light};
    end else begin
      if Enabled then Result := {#ButtonText_secondary_normal_light}
      else Result := {#ButtonText_secondary_disabled_light};
    end;
  end;
end;

{ A click on a drawn button presses the wizard's own, as long as that one could be pressed. }
procedure ThemedButtonClick(Sender: TObject);
var
  Real: TNewButton;
begin
  Real := ThemedButtons[TComponent(Sender).Tag].Real;
  if Real.Visible and Real.Enabled then
    Real.OnClick(Real);
end;

function ButtonImage(Index: Integer; State: String): TBitmapImage;
var
  Name: String;
begin
  Name := 'button-' + ThemedButtons[Index].Kind + '-' + State + '-' + ThemeMode + '.png';
  ExtractTemporaryFile(Name);
  Result := TBitmapImage.Create(WizardForm);
  Result.Parent := ThemedButtons[Index].Real.Parent;
  Result.BackColor := clNone;
  Result.Stretch := True;
  Result.PngImage.LoadFromFile(ExpandConstant('{tmp}\') + Name);
  Result.Visible := False;
  Result.Tag := Index;
  if State <> 'disabled' then
  begin
    Result.Cursor := crHand;
    Result.OnClick := @ThemedButtonClick;
  end;
end;

{ Puts the drawn button where the wizard put its own, and moves that one out of sight. }
procedure PlaceThemedButton(Index: Integer);
var
  Real: TNewButton;
  Text: TLabel;
  TextHeight: Integer;
begin
  Real := ThemedButtons[Index].Real;
  ThemedButtons[Index].X := Real.Left;
  ThemedButtons[Index].Y := Real.Top;
  ThemedButtons[Index].W := Real.Width;
  ThemedButtons[Index].H := Real.Height;
  ThemedButtons[Index].Normal.SetBounds(Real.Left, Real.Top, Real.Width, Real.Height);
  ThemedButtons[Index].Hover.SetBounds(Real.Left, Real.Top, Real.Width, Real.Height);
  ThemedButtons[Index].Disabled.SetBounds(Real.Left, Real.Top, Real.Width, Real.Height);
  Text := ThemedButtons[Index].Text;
  Text.AutoSize := True;
  TextHeight := Text.Height;
  Text.AutoSize := False;
  Text.SetBounds(Real.Left, Real.Top + (Real.Height - TextHeight) div 2, Real.Width, TextHeight);
  Real.Left := OffScreen;
end;

procedure AddThemedButton(Real: TNewButton; Kind: String);
var
  I: Integer;
  Text: TLabel;
begin
  I := GetArrayLength(ThemedButtons);
  SetArrayLength(ThemedButtons, I + 1);
  ThemedButtons[I].Real := Real;
  ThemedButtons[I].Kind := Kind;
  ThemedButtons[I].Normal := ButtonImage(I, 'normal');
  ThemedButtons[I].Hover := ButtonImage(I, 'hover');
  ThemedButtons[I].Disabled := ButtonImage(I, 'disabled');
  { Created last, so it is drawn over the images. }
  Text := TLabel.Create(WizardForm);
  Text.Parent := Real.Parent;
  Text.Transparent := True;
  Text.StyleElements := Text.StyleElements - [seFont];
  Text.Alignment := taCenter;
  if Kind = 'primary' then
    Text.Font.Style := [fsBold];
  Text.Caption := 'Ag';
  Text.Cursor := crHand;
  Text.Tag := I;
  Text.OnClick := @ThemedButtonClick;
  ThemedButtons[I].Text := Text;
  PlaceThemedButton(I);
end;

procedure SetShown(Control: TControl; Value: Boolean);
begin
  if Control.Visible <> Value then
    Control.Visible := Value;
end;

procedure SyncThemedButtons(Wnd: HWND; Msg: UINT; Id: UINT_PTR; Time: DWORD);
var
  I: Integer;
  Point: TCursorPoint;
  Real: TNewButton;
  Text: TLabel;
  Shown, Enabled, Over: Boolean;
  Caption: String;
  Color: TColor;
begin
  for I := 0 to GetArrayLength(ThemedButtons) - 1 do
  begin
    Real := ThemedButtons[I].Real;
    { The wizard placed its button again: follow it. }
    if Real.Left <> OffScreen then
      PlaceThemedButton(I);
    Shown := Real.Visible;
    Enabled := Real.Enabled;
    Over := False;
    if GetCursorPos(Point) and ScreenToClient(Real.Parent.Handle, Point) then
      Over := (Point.X >= ThemedButtons[I].X) and (Point.X < ThemedButtons[I].X + ThemedButtons[I].W) and
        (Point.Y >= ThemedButtons[I].Y) and (Point.Y < ThemedButtons[I].Y + ThemedButtons[I].H);
    SetShown(ThemedButtons[I].Normal, Shown and Enabled and not Over);
    SetShown(ThemedButtons[I].Hover, Shown and Enabled and Over);
    SetShown(ThemedButtons[I].Disabled, Shown and not Enabled);
    Text := ThemedButtons[I].Text;
    SetShown(Text, Shown);
    Caption := Real.Caption;
    StringChangeEx(Caption, '&', '', True);
    if Text.Caption <> Caption then
      Text.Caption := Caption;
    Color := ButtonTextColor(ThemedButtons[I].Kind, Enabled);
    if Text.Font.Color <> Color then
      Text.Font.Color := Color;
  end;
end;

procedure InitializeWizard;
begin
  AddThemedButton(WizardForm.BackButton, 'secondary');
  AddThemedButton(WizardForm.NextButton, 'primary');
  AddThemedButton(WizardForm.CancelButton, 'secondary');
  SyncThemedButtons(0, 0, 0, 0);
  { Tied to the wizard's window, so it stops when the wizard closes. }
  SetTimer(WizardForm.Handle, 1, 50, CreateCallback(@SyncThemedButtons));
end;
#endif

{ True when Dir is not already one of the entries in the user's Path. }
function NeedsAddPath(Dir: string): Boolean;
var
  Paths: string;
begin
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Paths) then
  begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(Paths) + ';') = 0;
end;

{ Removes Dir from the user's Path, leaving every other entry as it was. }
procedure RemoveFromPath(Dir: string);
var
  Paths: string;
  P: Integer;
begin
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Paths) then
    exit;
  P := Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(Paths) + ';');
  if P = 0 then
    exit;
  { P is where Dir starts in Paths. Drop it with the separator before it, or after it when first. }
  if P > 1 then
    Delete(Paths, P - 1, Length(Dir) + 1)
  else
    Delete(Paths, 1, Length(Dir) + 1);
  RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Paths);
end;

{ True when the app's updater ran this installer, which then starts the app again. }
function RelaunchRequested: Boolean;
begin
  Result := ExpandConstant('{param:relaunch|0}') = '1';
end;

{ Runs the installed latch.cmd with Args, its output in LogFile. True when it ran and exited 0. }
function RunLatch(Args, LogFile: string): Boolean;
var
  ResultCode: Integer;
begin
  { cmd /C strips the outer quotes, leaving: "<app>\latch.cmd" <args> > "<log>" 2>&1 }
  Result := Exec(ExpandConstant('{cmd}'),
    '/C ""' + ExpandConstant('{app}\latch.cmd') + '" ' + Args + ' > "' + LogFile + '" 2>&1"',
    ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  LogFile: string;
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('linkclients') and not RelaunchRequested then
  begin
    WizardForm.StatusLabel.Caption := 'Linking your MCP clients to LatchVerify...';
    LogFile := ExpandConstant('{app}\setup.log');
    if not RunLatch('setup --all', LogFile) and not WizardSilent then
      MsgBox('LatchVerify is installed, but linking your MCP clients did not finish.' + #13#10#13#10 +
        'Details are in ' + LogFile + '.' + #13#10 +
        'Run "latch setup --all" in a new terminal to try again.', mbInformation, MB_OK);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    { The app first, so it does not link the clients again while they are unlinked. }
    Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM latchverify-desktop.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    { Before the files go: give every MCP client its original server commands back. latch.lock stays. }
    RunLatch('setup --remove --all', ExpandConstant('{%TEMP}\latchverify-unlink.log'));
    RemoveFromPath(ExpandConstant('{app}'));
  end;
end;
