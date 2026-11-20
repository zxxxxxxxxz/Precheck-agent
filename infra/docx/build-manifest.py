"""Freeze an actual built runtime; no claimed font hashes or resolutions are invented."""
import hashlib
import json
import os
import platform
import subprocess
import sys

def sha(path):
    value = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()

def output(*args):
    return subprocess.check_output(args, text=True).strip()

def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()

font_rows = set(output('fc-list', '--format', '%{family}\t%{file}\n').splitlines())
fonts = []
for row in sorted(font_rows):
    family, file = row.split('\t', 1)
    fonts.append({'family': family, 'file': os.path.realpath(file), 'sha256': sha(file)})
names = {'Aptos', 'Arial', 'Times New Roman', 'Calibri', 'Courier New', 'Tahoma', 'Verdana', 'Segoe UI', 'SimSun', '宋体', 'SimHei', '黑体', 'DengXian', '等线', 'Microsoft YaHei', '微软雅黑', 'MingLiU', 'PMingLiU', '新細明體', 'Microsoft JhengHei', '微軟正黑體', 'Wingdings', 'Symbol', 'Noto Sans Symbols 2'}
names.update({'FangSong','仿宋','仿宋_GB2312','KaiTi','楷体','楷体_GB2312','NSimSun','新宋体','STSong','华文宋体','STHeiti','华文黑体','STKaiti','华文楷体','Cambria','Georgia'})
names.update({'華康儷中宋(P)', '華康儷粗宋(P)', 'Batang', 'MS Gothic', 'Segoe UI Emoji'})
for font in fonts:
    names.update(font['family'].split(','))
aliases = []
for name in sorted(names):
    resolved, file = output('fc-match', '--format', '%{family}\t%{file}', '--', name).split('\t', 1)
    aliases.append({'requested': name, 'resolved': resolved, 'file': os.path.realpath(file), 'sha256': sha(file)})
files = []
# Only immutable runtime paths; build-time /etc/resolv.conf/hosts mounts are not captured.
for top in ['/usr', '/opt', '/etc/fonts', '/var/cache/fontconfig']:
    for current, dirs, names in os.walk(top, followlinks=False):
        dirs.sort()
        for name in sorted(names):
            file = os.path.join(current, name)
            if os.path.isfile(file) and not os.path.islink(file):
                files.append({'path': file, 'sha256': sha(file), 'size': os.stat(file).st_size})
packages = [{'name': row.split('\t')[0], 'version': row.split('\t')[1]} for row in output('dpkg-query', '-W', '-f=${Package}\t${Version}\n').splitlines()]
manifest = {'schemaVersion': 'docx-runtime.v1', 'platform': 'linux', 'architecture': {'x86_64':'x64','aarch64':'arm64'}[platform.machine()], 'baseImage':'node:24.21.0-bookworm@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0', 'snapshot':'signed Debian repositories; exact resolved versions and runtime bytes locked below', 'libreOfficeVersion': output('libreoffice', '--version'), 'packages':packages, 'files':files, 'fonts':fonts, 'aliases':aliases, 'fontManifestSha256':hashlib.sha256(json_bytes({'fonts':fonts,'aliases':aliases})).hexdigest()}
with open(sys.argv[1], 'wb') as target:
    target.write(json_bytes(manifest))
