#!/usr/bin/env python3
"""Normalize public experiment transcripts, including tool failures and tracebacks."""
import argparse
from pathlib import Path
import re

def normalize(text):
    text=text.replace('\x00','').replace('\r\n','\n')
    text=re.sub(r'project-[0-9a-f][0-9a-f-]{8,}', '<cloud-project>', text, flags=re.I)
    # Preserve the failing module's basename, not the user's local installation layout.
    text=re.sub(r'/opt/homebrew[^\s"\'\)\]]*',
        lambda m:'<local-toolchain>/'+m[0].rsplit('/',1)[-1],text)
    text=re.sub(r'[^\s"\']*google-cloud-sdk[^\s"\'\)\]]*',
        lambda m:'<gcloud-install>/'+m[0].rsplit('/',1)[-1],text)
    # Scrub path-shaped home references only. Never replace the bare home-folder
    # name as a substring: short names such as "runner" also appear as ordinary
    # words in tool diagnostics ("connecting runner pipe-in", "spawn runner").
    home=str(Path.home())
    if home:
        text=text.replace(home,'<host-home>')
        home_name=re.escape(Path.home().name)
        text=re.sub(rf'(?<=[/\\]){home_name}(?=[/\\\'"\s]|$)','<test-user>',text)
    text=re.sub(r'C:(\\+)Users(\\+)[^\\\s"\']+',
        lambda m:'C:'+m[1]+'Users'+m[2]+'<test-user>',text)
    return '\n'.join(line.rstrip() for line in text.splitlines()).rstrip()+'\n'

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--check',action='store_true');args=parser.parse_args()
    repo=Path(__file__).resolve().parents[2]
    changed=[]
    for directory in ['spikes/s2-windows-fence/results','spikes/s8-secrets/results']:
        for p in sorted((repo/directory).glob('*.txt')):
            before=p.read_bytes().decode(errors='replace');after=normalize(before)
            if before!=after:
                changed.append(str(p.relative_to(repo)))
                if not args.check:p.write_text(after)
    print(('Unnormalized' if args.check else 'Normalized')+' result files: '+str(len(changed)))
    for name in changed:print(name)
    raise SystemExit(1 if args.check and changed else 0)
