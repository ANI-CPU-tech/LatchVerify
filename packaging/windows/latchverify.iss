; LatchVerify installer (Inno Setup 6). Built by .github/workflows/build-installers.yml:
;
;   ISCC /DAppVersion=1.2.3 /DFileVersion=1.2.3.0 /DStageDir=<stage> /DOutputDir=<out> packaging\windows\latchverify.iss
;
; <stage> holds app\ (packaging/stage.ts) and node\ (fetch-node.ps1). Add /DSignTool=1 together with
; /Slatchsign=<command> to Authenticode-sign the installer and uninstaller.
;
; Per-user install: no administrator rights, nothing written outside the user's profile. After
; installing it links every MCP client found (`latch setup --all`): their MCP servers start behind
; the latch proxy and their tools are pinned in %APPDATA%\LatchVerify\latch.lock, created on the
; spot. Before uninstalling it unlinks them all (`latch setup --remove --all`); latch.lock is kept,
; so a reinstall keeps the approvals.

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
AppPublisherURL=https://github.com/vinayakkam/LatchVerify
AppSupportURL=https://github.com/vinayakkam/LatchVerify/issues
AppUpdatesURL=https://github.com/vinayakkam/LatchVerify/releases
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
LicenseFile={#RepoDir}\LICENSE
SetupIconFile=latchverify.ico
UninstallDisplayIcon={app}\latchverify.ico
UninstallDisplayName=LatchVerify
OutputDir={#OutputDir}
OutputBaseFilename=latchverify-{#AppVersion}-windows-x64-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
#ifdef SignTool
SignTool=latchsign
SignedUninstaller=yes
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: linkclients; Description: "Link your MCP clients now (Claude Code, Cursor, VS Code and others found): their servers start behind latch and their tools are pinned in your latch.lock (recommended)"
Name: addtopath; Description: "Add latch to PATH for new terminals"

[InstallDelete]
; Files from an older version that the new one no longer ships.
Type: filesandordirs; Name: "{app}\app"

[Files]
Source: "{#StageDir}\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\node\*"; DestDir: "{app}\node"; Flags: ignoreversion recursesubdirs
Source: "latch.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "latchverify.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\LatchVerify Review"; Filename: "{app}\latch.cmd"; Parameters: "review --ui"; WorkingDir: "{userdocs}"; IconFilename: "{app}\latchverify.ico"; Comment: "Review MCP tool changes that LatchVerify blocked"
Name: "{group}\Uninstall LatchVerify"; Filename: "{uninstallexe}"

[Registry]
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}"; Tasks: addtopath; Check: NeedsAddPath(ExpandConstant('{app}'))

[UninstallDelete]
Type: files; Name: "{app}\setup.log"

[Code]
const
  EnvKey = 'Environment';

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
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('linkclients') then
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
begin
  if CurUninstallStep = usUninstall then
  begin
    { Before the files go: give every MCP client its original server commands back. latch.lock stays. }
    RunLatch('setup --remove --all', ExpandConstant('{%TEMP}\latchverify-unlink.log'));
    RemoveFromPath(ExpandConstant('{app}'));
  end;
end;
