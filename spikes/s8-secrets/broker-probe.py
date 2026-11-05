#!/usr/bin/python3
"""Private real keyring, semantic broker, filtered socket, local helper fixtures."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import dbus

SVC='org.freedesktop.Secret.Service'
ROOT='/org/freedesktop/secrets'
NAME='org.freedesktop.secrets'
EXTERNAL='com.waifucave.clover.fixture.external'

with tempfile.TemporaryDirectory(prefix='clover-broker-') as temp:
    root=Path(temp); processes=[]
    def bus():
        p=subprocess.Popen(['dbus-daemon','--session','--nofork','--print-address'],stdout=subprocess.PIPE,text=True)
        processes.append(p); return p.stdout.readline().strip()
    backend=bus(); frontend=bus()
    env=dict(os.environ,HOME=temp,XDG_DATA_HOME=temp+'/data',XDG_CONFIG_HOME=temp+'/config',
        XDG_RUNTIME_DIR=temp,DBUS_SESSION_BUS_ADDRESS=backend)
    keyring=subprocess.Popen(['gnome-keyring-daemon','--foreground','--unlock','--components=secrets',
        '--control-directory='+temp+'/control'],env=env,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    processes.append(keyring); keyring.stdin.write(secrets.token_bytes(32).hex().encode()); keyring.stdin.close()
    try:
        conn=dbus.bus.BusConnection(backend)
        for _ in range(100):
            if conn.name_has_owner(NAME): break
            time.sleep(.05)
        tokens={tool:secrets.token_hex(24) for tool in ('gh','docker','git','clover')}
        for tool,token in tokens.items():
            application='com.waifucave.clover.core.test' if tool=='clover' else EXTERNAL
            r=subprocess.run(['secret-tool','store','--label=Clover disposable credential fixture',
                'application',application,'tool',tool],env=env,input=token.encode(),capture_output=True,timeout=10)
            assert r.returncode==0
        raw=conn.get_object(NAME,ROOT)
        hidden=raw.SearchItems({'tool':'clover'},dbus_interface=SVC)[0][0]
        external=raw.SearchItems({'tool':'git'},dbus_interface=SVC)[0][0]
        broker=subprocess.Popen(['/usr/bin/python3',str(Path(__file__).with_name('secret-broker.py'))],
            env=dict(env,CLOVER_BACKEND_BUS=backend,CLOVER_FRONTEND_BUS=frontend),stdout=subprocess.PIPE,text=True)
        processes.append(broker); assert broker.stdout.readline().strip()=='broker-ready'
        sock=temp+'/proxy'
        proxy=subprocess.Popen(['xdg-dbus-proxy',frontend,sock,'--filter','--talk='+NAME])
        processes.append(proxy)
        for _ in range(100):
            if Path(sock).exists(): break
            time.sleep(.02)
        filtered=dbus.bus.BusConnection('unix:path='+sock)
        obj=filtered.get_object(NAME,ROOT,introspect=False)
        _,session=obj.OpenSession('plain',dbus.String('',variant_level=1),dbus_interface=SVC)
        def check(name,ok):
            print(json.dumps({'test':name,'pass':bool(ok)}),flush=True)
            assert ok,name
        check('broker-search-clover-hidden',not any(obj.SearchItems({'tool':'clover'},dbus_interface=SVC)))
        found=obj.SearchItems(dbus.Dictionary({},signature='ss'),dbus_interface=SVC)[0]
        check('broker-search-results-filtered',hidden not in found and external in found and len(found)==3)
        for name,paths in [('direct-clover',[hidden]),('mixed-bulk',[external,hidden])]:
            try:
                obj.GetSecrets(dbus.Array(paths,signature='o'),session,dbus_interface=SVC)
                denied=False
            except dbus.DBusException as e: denied=e.get_dbus_name().endswith('AccessDenied')
            check('broker-'+name+'-denied',denied)
        collection=obj.ReadAlias('default',dbus_interface=SVC)
        coll=filtered.get_object(NAME,collection,introspect=False)
        listed=coll.Get('org.freedesktop.Secret.Collection','Items',dbus_interface='org.freedesktop.DBus.Properties')
        check('broker-collection-items-filtered',hidden not in listed and len(listed)==3)
        for destination in ('org.freedesktop.systemd1','org.freedesktop.portal.Desktop','org.gnome.Terminal'):
            try:
                target=filtered.get_object(destination,'/',introspect=False)
                target.Ping(dbus_interface='org.freedesktop.DBus.Peer',timeout=2)
                denied=False
            except dbus.DBusException as e:
                denied=e.get_dbus_name() in ('org.freedesktop.DBus.Error.ServiceUnknown','org.freedesktop.DBus.Error.AccessDenied','org.freedesktop.DBus.Error.NameHasNoOwner')
            check('broker-no-host-'+destination,denied)
        # Only the final proxy is mounted. Neither real bus nor keyring tree is exposed.
        work=root/'work'; work.mkdir()
        bwrap='/usr/local/libexec/clover-spike-bwrap'
        if not Path(bwrap).exists(): bwrap='bwrap'
        common=[bwrap,'--die-with-parent','--new-session','--unshare-all','--cap-drop','ALL',
            '--ro-bind','/','/','--tmpfs','/tmp','--tmpfs','/run','--tmpfs','/home',
            '--proc','/proc','--dev','/dev','--dir','/tmp/work','--bind',str(work),'/tmp/work',
            '--ro-bind',sock,'/tmp/proxy','--clearenv','--setenv','HOME','/tmp/work',
            '--setenv','PATH','/usr/bin:/bin','--setenv','DBUS_SESSION_BUS_ADDRESS','unix:path=/tmp/proxy']
        for tool in ('gh','docker','git'):
            r=subprocess.run(common+['--','secret-tool','lookup','application',EXTERNAL,'tool',tool],capture_output=True,timeout=10)
            check('broker-'+tool+'-credential-lookup',r.returncode==0 and r.stdout.decode().strip()==tokens[tool])
        # Real git credential plumbing, with a local Secret Service-backed helper.
        helper=work/'credential-helper'
        helper.write_text('#!/bin/sh\ncat >/dev/null\nprintf "username=fixture\\npassword="\nsecret-tool lookup application '+EXTERNAL+' tool git\nprintf "\\n"\n')
        helper.chmod(0o755)
        r=subprocess.run(common+['--','git','-c','credential.helper=/tmp/work/credential-helper',
            'credential','fill'],input=b'protocol=https\nhost=fixture.invalid\n\n',capture_output=True,timeout=10)
        check('broker-git-credential-fill',r.returncode==0 and ('password='+tokens['git']) in r.stdout.decode())
        r=subprocess.run(common+['--','secret-tool','lookup','tool','clover'],capture_output=True,timeout=10)
        check('broker-fenced-clover-lookup-denied',r.returncode!=0 and not r.stdout)
        print(json.dumps({'test':'broker-scope','real_secret_service':True,'git_credential_plumbing':True,
            'gh_and_docker':'local store-lookup fixtures; no account login or daemon socket'}),flush=True)
        def median_ms(fn,n=25):
            samples=[]
            for _ in range(n):
                start=time.perf_counter(); fn(); samples.append((time.perf_counter()-start)*1000)
            samples.sort()
            return {'median_ms':round(samples[len(samples)//2],2),'p95_ms':round(samples[max(0,int(len(samples)*0.95)-1)],2),'runs':n}
        _,raw_session=raw.OpenSession('plain',dbus.String('',variant_level=1),dbus_interface=SVC)
        lookup=['secret-tool','lookup','application',EXTERNAL,'tool','git']
        def tool_lookup(address):
            r=subprocess.run(lookup,env=dict(env,DBUS_SESSION_BUS_ADDRESS=address),capture_output=True,timeout=10)
            assert r.returncode==0 and r.stdout.decode().strip()==tokens['git']
        latency={
            'filtered_semantic_search':median_ms(lambda: obj.SearchItems({'tool':'git'},dbus_interface=SVC)),
            'direct_backend_search':median_ms(lambda: raw.SearchItems({'tool':'git'},dbus_interface=SVC)),
            'filtered_get_secret':median_ms(lambda: obj.GetSecrets(dbus.Array([external],signature='o'),session,dbus_interface=SVC)),
            'direct_get_secret':median_ms(lambda: raw.GetSecrets(dbus.Array([external],signature='o'),raw_session,dbus_interface=SVC)),
            'tool_lookup_via_broker':median_ms(lambda: tool_lookup('unix:path='+sock),n=15),
            'tool_lookup_direct':median_ms(lambda: tool_lookup(backend),n=15),
        }
        # Timings only: no secret value is printed. The tool rows are whole secret-tool
        # processes outside bubblewrap, so they isolate proxy plus broker from fence startup.
        print(json.dumps({'test':'broker-latency',**latency,
            'scope':'filtered xdg-dbus-proxy plus semantic broker versus the direct backend bus; in-process D-Bus calls and whole secret-tool lookups; excludes bubblewrap startup'}),flush=True)
    finally:
        for p in reversed(processes):
            p.terminate()
            try: p.wait(timeout=5)
            except subprocess.TimeoutExpired: p.kill(); p.wait()
