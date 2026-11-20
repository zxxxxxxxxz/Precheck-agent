"""Metadata-only startup test. Never prints paths, environments, or documents."""
import os
import socket

assert not os.path.exists('/app') and not os.path.exists('/run/secrets')
assert set(os.environ) <= {'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SAL_USE_VCLPLUGIN', 'LC_CTYPE', 'PWD'}
assert os.environ.get('HOME') == '/work' and os.environ.get('PWD') == '/work'
assert os.listdir('/proc') == []
assert os.getpid() <= 4
assert len(socket.if_nameindex()) <= 1
try:
    with open('/usr/docx-write-probe', 'wb'):
        pass
except OSError:
    pass
else:
    raise RuntimeError('rootfs_is_writable')
print('docx-sandbox-probe-v1:ok')
