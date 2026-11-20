"""Append only our project startup to the AutoDL-supported startup hook."""
from pathlib import Path
import datetime
import shutil

hook = Path('/etc/autodl.sh')
text = hook.read_text() if hook.exists() else '#!/usr/bin/env bash\n'
marker = '# BEGIN HSBC GPU5090'
if marker not in text:
    if hook.exists():
        backup = Path('/data/hsbc/config/supervisor') / ('autodl.sh.before-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
        shutil.copy2(hook, backup)
    text += '\n' + marker + '\n/data/hsbc/scripts/start.sh\n# END HSBC GPU5090\n'
    hook.write_text(text)
    hook.chmod(0o755)
print('AutoDL startup hook installed; platform reboot has not been performed.')
