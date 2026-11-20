"""Fixed command executed only inside the per-job bubblewrap namespace."""
import os
import resource
import sys
import subprocess

maximum_file = int(sys.argv[1])
cpu_seconds = int(sys.argv[2])
assert 0 < maximum_file <= 64 * 1024 * 1024 and 0 < cpu_seconds <= 300
resource.setrlimit(resource.RLIMIT_FSIZE, (maximum_file, maximum_file))
resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
resource.setrlimit(resource.RLIMIT_AS, (1536 * 1024 * 1024, 1536 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
os.umask(0o077)
os.makedirs('/work/profile/user', exist_ok=True)
with open('/work/profile/user/registrymodifications.xcu', 'w') as profile:
    profile.write('''<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item></oor:items>''')
# The distro launcher requires /proc; invoke the fixed engine with its fixed library path.
# Official EXITHELPER_NORMAL_RESTART (81) requests a first-profile restart with all args.
os.environ['LD_LIBRARY_PATH'] = '/usr/lib/libreoffice/program'
command = ['/usr/lib/libreoffice/program/soffice.bin', '--headless', '--nologo', '--nodefault', '--norestore', '--nolockcheck', '-env:UserInstallation=file:///work/profile', '--convert-to', 'pdf:writer_pdf_Export', '--outdir', '/out', '/input/input.docx']
for attempt in range(2):
    result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode != 81 or attempt == 1:
        sys.exit(result.returncode if result.returncode >= 0 else 1)
