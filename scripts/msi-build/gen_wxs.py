#!/usr/bin/env python3
# wxs generator v2 (pohon benar): Directory nested + Component per file → wixl
import os, uuid, html

ROOT = '/tmp/cb-msi/payload'
OUT = '/tmp/cb-msi/ChatBareng.wxs'
NS_UUID = uuid.UUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8')

def guid_for(key):
    return '{' + str(uuid.uuid3(NS_UUID, key)).upper() + '}'

# pohon
tree = {}
for dirpath, dirnames, filenames in os.walk(ROOT):
    dirnames.sort()
    rel = os.path.relpath(dirpath, ROOT)
    node = tree
    if rel != '.':
        for part in rel.replace(os.sep, '/').split('/'):
            node = node.setdefault(part, {})
    node['::files'] = sorted(filenames)

def did_for(key):
    return 'D' + str(uuid.uuid3(NS_UUID, 'dir:' + key)).replace('-', '')[:28].upper()

def comp_id(rel):
    key = rel.replace('\\', '/')
    return 'C' + str(uuid.uuid3(NS_UUID, 'comp:' + key)).replace('-', '')[:32].upper()

ILLEGAL = {'con', 'prn', 'aux', 'nul'} | {f'com{i}' for i in range(1, 10)} | {f'lpt{i}' for i in range(1, 10)}

wxs = []
IND = ['  ']
def emit(node, name, relpath, depth, parent_attr):
    did = 'INSTALLDIR' if relpath == '' else did_for(relpath)
    if relpath == '':
        wxs.append(f'{IND[0]*depth}  <Directory Id="{did}" Name="ChatBareng">')
    elif relpath.split('/') == []:
        pass
    else:
        wxs.append(f'{IND[0]*depth}    <Directory Id="{did}" Name="{html.escape(name, quote=True)}">')
    for sub, child in node.items():
        if sub == '::files':
            continue
        emit(child, sub, (relpath + '/' + sub) if relpath else sub, depth + 1, did)
    # file di dir ini
    files = node.get('::files', [])
    for fn in files:
        rel_file = (relpath + '/' + fn) if relpath else fn
        stem = fn.split('.')[0].lower()
        bad = (stem in ILLEGAL or fn.endswith(' ') or fn.endswith('.') or any(c in fn for c in '"<>|:*?/\\') or len(fn) > 250)
        if bad:
            print('SKIP:', rel_file)
            continue
        cid = comp_id(rel_file)
        wxs.append(f'{IND[0]*depth}      <Component Id="{cid}" Guid="{guid_for("file:" + rel_file)}">')
        wxs.append(f'{IND[0]*depth}        <File Id="F{cid}" Name="{html.escape(fn, quote=True)}" Source="{ROOT}/{rel_file}" Compressed="yes"/>')
        wxs.append(f'{IND[0]*depth}      </Component>')
        refs.append(f'{IND[0]}"        <ComponentRef Id="{cid}"/>'.replace(IND[0] + '"        <ComponentRef', '          <ComponentRef'))
    if relpath != '':
        wxs.append(f'{IND[0]*depth}    </Directory>')
    else:
        wxs.append(f'{IND[0]*depth}  </Directory>')

refs = []
A = wxs.append
A('<?xml version="1.0" encoding="utf-8"?>')
A('<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">')
A('  <Product Id="*" Name="ChatBareng - WhatsApp CS Hub" Language="1033" Version="4.6.13" Manufacturer="kanaaka" UpgradeCode="{F8E6D3AE-9C1B-4A77-9E14-77C01A2CB461}">')
A('    <Package InstallerVersion="400" Compressed="yes" Description="ChatBareng WhatsApp CS Hub - installer Windows"/>')
A('    <Property Id="ALLUSERS" Value="1"/>')

A('    <Property Id="MSIRESTARTMANAGERCONTROL" Value="Disable"/>')
A('    <Media Id="1" Cabinet="payload.cab" EmbedCab="yes"/>')
A('    <Directory Id="TARGETDIR">')
A('      <Directory Id="ProgramFilesFolder">')
emit(tree, 'ChatBareng', '', 0, None)
A('      </Directory>')
A('      <Directory Id="CommonAppDataFolder">')
A('        <Directory Id="CBPDATA" Name="ChatBareng">')
A('          <Directory Id="CBPDATAdata" Name="data">')
A('            <Component Id="CBDB" Guid="{7C2A9D0F-4E31-4B6A-9D8F-5A1B2C3D4E5F}">')
A('              <File Id="FCBDB" Name="wa-cs-hub.db" Source="/tmp/cb-msi/payload-predata/wa-cs-hub.db"/>')
A('            </Component>')
A('            <Component Id="CBDBDIRS" Guid="{7C2A9D0F-4E31-4B6A-9D8F-5A1B2C3D4E60}">')
A('              <CreateFolder/>')
A('              <RemoveFolder Id="CBPDataDel" On="uninstall"/>')
A('              <RegistryValue Root="HKLM" Key="Software\\ChatBareng" Name="pdata" Type="integer" Value="1" KeyPath="yes"/>')
A('            </Component>')
A('          </Directory>')
A('        </Directory>')
A('      </Directory>')
A('      <Directory Id="ProgramMenuFolder">')
A('        <Directory Id="CBMenuDir" Name="ChatBareng">')
A('          <Component Id="CBSM" Guid="{CBBB0A01-2C3D-4E5F-8A9B-001122334455}">')
A('            <Shortcut Id="CBRun" Name="ChatBareng" Description="Jalankan server ChatBareng" Target="[SystemFolder]cmd.exe" Arguments=\'/c "[INSTALLDIR]start.bat"\' WorkingDirectory="INSTALLDIR"/>')
A('            <Shortcut Id="CBBaca" Name="Panduan ChatBareng" Description="Panduan install/pemakaian" Target="[[INSTALLDIR]PANDUAN-INSTALL-WINDOWS.txt]"/>')
A('            <RemoveFolder Id="CBMenuDel" On="uninstall"/>')
A('            <RegistryValue Root="HKCU" Key="Software\\ChatBareng" Name="installed" Type="integer" Value="1" KeyPath="yes"/>')
A('          </Component>')
A('        </Directory>')
A('      </Directory>')
A('    </Directory>')
A('    <Feature Id="Main" Level="1" Title="ChatBareng">')
A('      <ComponentRef Id="CBSM"/>')
A('      <ComponentRef Id="CBDB"/>')
A('      <ComponentRef Id="CBDBDIRS"/>')
A('\n'.join(refs))
A('    </Feature>')
A('  </Product>')
A('</Wix>')

open(OUT, 'w', encoding='utf-8').write('\n'.join(wxs) + '\n')
print('wxs:', OUT, '| refs:', len(refs) + 1)
