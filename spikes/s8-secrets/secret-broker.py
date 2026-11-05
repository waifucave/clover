#!/usr/bin/python3
"""Read-only semantic Secret Service spike. Private frontend/backend buses only.

Each returned item is re-authorized from backend attributes. Unknown/mutating APIs fail
closed. This is a fixture broker, not a production service or an application identity check.
"""
import os
import sys
import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

SERVICE='org.freedesktop.secrets'
ROOT='/org/freedesktop/secrets'
SVC='org.freedesktop.Secret.Service'
ITEM='org.freedesktop.Secret.Item'
COLL='org.freedesktop.Secret.Collection'
PROPS='org.freedesktop.DBus.Properties'
SESSION='org.freedesktop.Secret.Session'

class Denied(dbus.DBusException):
    _dbus_error_name='org.freedesktop.DBus.Error.AccessDenied'

class Broker:
    def __init__(self,backend,frontend):
        self.backend=backend; self.frontend=frontend; self.objects={}; self.sessions={}
        self.service=backend.get_object(SERVICE,ROOT)
        self.root=Root(self,ROOT)
    def object(self,path): return self.backend.get_object(SERVICE,str(path))
    def allowed(self,path):
        try:
            attrs=self.object(path).Get(ITEM,'Attributes',dbus_interface=PROPS)
            # Explicit external fixture applications; unknown or Clover items denied.
            return str(attrs.get('application',''))=='com.waifucave.clover.fixture.external'
        except dbus.DBusException: return False
    def item(self,path):
        if not self.allowed(path): raise Denied('Item not admitted')
        if str(path) not in self.objects: self.objects[str(path)]=Item(self,path)
        return dbus.ObjectPath(path)
    def collection(self,path):
        if str(path) not in self.objects: self.objects[str(path)]=Collection(self,path)
        return dbus.ObjectPath(path)
    def session(self,path,sender):
        if self.sessions.get(str(path)) != sender: raise Denied('Session not admitted')

class Base(dbus.service.Object):
    def __init__(self,broker,path):
        self.b=broker; self.path=str(path)
        super().__init__(broker.frontend,self.path)
    @dbus.service.method(PROPS,in_signature='ss',out_signature='v')
    def Get(self,interface,name):
        return self.properties(str(interface))[str(name)]
    @dbus.service.method(PROPS,in_signature='s',out_signature='a{sv}')
    def GetAll(self,interface): return self.properties(str(interface))
    @dbus.service.method(PROPS,in_signature='ssv',out_signature='')
    def Set(self,interface,name,value): raise Denied('Read-only broker')
    def properties(self,interface): raise Denied('Interface not admitted')

class Root(Base):
    def properties(self,interface):
        if interface!=SVC: raise Denied('Interface not admitted')
        collections=self.b.service.Get(SVC,'Collections',dbus_interface=PROPS)
        return {'Collections':dbus.Array([self.b.collection(p) for p in collections],signature='o')}
    @dbus.service.method(SVC,in_signature='sv',out_signature='vo',sender_keyword='sender')
    def OpenSession(self,algorithm,value,sender=None):
        if algorithm not in ('plain','dh-ietf1024-sha256-aes128-cbc-pkcs7'): raise Denied('Algorithm not admitted')
        output,path=self.b.service.OpenSession(algorithm,value,dbus_interface=SVC)
        self.b.sessions[str(path)]=sender
        self.b.objects[str(path)]=Session(self.b,path)
        return output,path
    @dbus.service.method(SVC,in_signature='s',out_signature='o')
    def ReadAlias(self,name):
        if name not in ('default','session'): raise Denied('Alias not admitted')
        path=self.b.service.ReadAlias(name,dbus_interface=SVC)
        return self.b.collection(path) if str(path)!='/' else path
    @dbus.service.method(SVC,in_signature='a{ss}',out_signature='aoao')
    def SearchItems(self,attributes):
        found,locked=self.b.service.SearchItems(attributes,dbus_interface=SVC)
        return ([self.b.item(p) for p in found if self.b.allowed(p)],
                [self.b.item(p) for p in locked if self.b.allowed(p)])
    @dbus.service.method(SVC,in_signature='ao',out_signature='aoo')
    def Unlock(self,paths):
        # Only already-unlocked admitted items: never invoke a UI prompt or unlock Clover.
        admitted=[]
        for path in paths:
            self.b.item(path)
            if self.b.object(path).Get(ITEM,'Locked',dbus_interface=PROPS): raise Denied('Locked item')
            admitted.append(path)
        return admitted,dbus.ObjectPath('/')
    @dbus.service.method(SVC,in_signature='aoo',out_signature='a{o(oayays)}',sender_keyword='sender')
    def GetSecrets(self,paths,session,sender=None):
        self.b.session(session,sender)
        for p in paths: self.b.item(p)
        result=self.b.service.GetSecrets(paths,session,dbus_interface=SVC)
        # Revalidate returned keys, not just inputs; no unrequested/denied items may leak.
        for p in result:
            if p not in paths or not self.b.allowed(p): raise Denied('Unexpected item')
        return result

class Item(Base):
    def properties(self,interface):
        if interface!=ITEM or not self.b.allowed(self.path): raise Denied('Item not admitted')
        properties=self.b.object(self.path).GetAll(ITEM,dbus_interface=PROPS)
        return {k:v for k,v in properties.items() if k in ('Locked','Attributes','Label','Created','Modified')}
    @dbus.service.method(ITEM,in_signature='o',out_signature='(oayays)',sender_keyword='sender')
    def GetSecret(self,session,sender=None):
        self.b.session(session,sender); self.b.item(self.path)
        return self.b.object(self.path).GetSecret(session,dbus_interface=ITEM)
    @dbus.service.method(ITEM,in_signature='(oayays)',out_signature='')
    def SetSecret(self,value): raise Denied('Read-only broker')
    @dbus.service.method(ITEM,in_signature='',out_signature='o')
    def Delete(self): raise Denied('Read-only broker')

class Collection(Base):
    def properties(self,interface):
        if interface!=COLL: raise Denied('Interface not admitted')
        props=self.b.object(self.path).GetAll(COLL,dbus_interface=PROPS)
        props['Items']=dbus.Array([self.b.item(p) for p in props.get('Items',[]) if self.b.allowed(p)],signature='o')
        return props
    @dbus.service.method(COLL,in_signature='a{ss}',out_signature='ao')
    def SearchItems(self,attributes):
        paths=self.b.object(self.path).SearchItems(attributes,dbus_interface=COLL)
        return [self.b.item(p) for p in paths if self.b.allowed(p)]
    @dbus.service.method(COLL,in_signature='a{sv}(oayays)b',out_signature='oo')
    def CreateItem(self,props,secret,replace): raise Denied('Read-only broker')
    @dbus.service.method(COLL,in_signature='',out_signature='o')
    def Delete(self): raise Denied('Read-only broker')

class Session(Base):
    @dbus.service.method(SESSION,in_signature='',out_signature='',sender_keyword='sender')
    def Close(self,sender=None):
        self.b.session(self.path,sender)
        self.b.object(self.path).Close(dbus_interface=SESSION)
        self.b.sessions.pop(self.path,None)
        self.remove_from_connection()

if __name__=='__main__':
    DBusGMainLoop(set_as_default=True)
    backend=dbus.bus.BusConnection(os.environ['CLOVER_BACKEND_BUS'])
    frontend=dbus.bus.BusConnection(os.environ['CLOVER_FRONTEND_BUS'])
    name=dbus.service.BusName(SERVICE,frontend)
    broker=Broker(backend,frontend)
    print('broker-ready',flush=True)
    GLib.MainLoop().run()
