// Spike only: launch compatibility measurement, NOT an admitted security boundary.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class CloverLaunchProbe {
    [StructLayout(LayoutKind.Sequential)] struct SIDATTR { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {
        public int cb; public string reserved, desktop, title;
        public int x,y,xsize,ysize,xchars,ychars,fill,flags;
        public short show,reserved2; public IntPtr reservedPtr,stdin,stdout,stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct SIX { public SI si; public IntPtr attrs; }
    [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public int pid,tid; }
    [StructLayout(LayoutKind.Sequential)] struct CAPS { public IntPtr sid,caps; public uint count,reserved; }
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h,uint code);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr p,uint access,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr t,uint flags,uint dc,IntPtr ds,uint pc,IntPtr ps,uint rc,IntPtr rs,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr t,int cls,IntPtr value,int size);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSidToSid(string s,out IntPtr sid);
    [DllImport("advapi32.dll")] static extern int GetLengthSid(IntPtr sid);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessAsUser(IntPtr t,string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SIX si,out PI pi);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attr,IntPtr value,IntPtr size,IntPtr prev,IntPtr ret);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string desc,IntPtr caps,uint count,out IntPtr sid);
    [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name,out IntPtr sid);
    [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
    [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text,uint revision,out IntPtr sd,out uint size);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetKernelObjectSecurity(IntPtr h,uint info,IntPtr sd);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorDacl(IntPtr sd,out bool present,out IntPtr acl,out bool defaulted);
    [StructLayout(LayoutKind.Sequential)] struct SA { public int size; public IntPtr sd; public bool inherit; }
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateDesktop(string name,IntPtr device,IntPtr mode,uint flags,uint access,ref SA sa);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    // Well-known Restricted Code SID, for compatibility only; not a per-session identity.
    public const string RestrictSid = "S-1-5-12";
    public static string AppSid(string name) {
        IntPtr sid; int hr=CreateAppContainerProfile(name,name,"Clover isolated spike",IntPtr.Zero,0,out sid);
        if(hr<0) { hr=DeriveAppContainerSidFromAppContainerName(name,out sid); if(hr<0) Marshal.ThrowExceptionForHR(hr); }
        try { return new System.Security.Principal.SecurityIdentifier(sid).Value; } finally { FreeSid(sid); }
    }
    public static void RemoveApp(string name) { int hr=DeleteAppContainerProfile(name); if(hr<0) Marshal.ThrowExceptionForHR(hr); }
    public static string Run(string mode,string exe,string arguments,string cwd,string appName) {
        IntPtr original=IntPtr.Zero,token=IntPtr.Zero,sid=IntPtr.Zero,entry=IntPtr.Zero,attrs=IntPtr.Zero,cap=IntPtr.Zero,sd=IntPtr.Zero,desktop=IntPtr.Zero;
        PI pi=new PI(); bool initialized=false; var watch=Stopwatch.StartNew();
        try {
            SI si=new SI(); si.cb=Marshal.SizeOf(typeof(SI)); si.desktop="";
            StringBuilder cmd=new StringBuilder("\""+exe+"\" "+arguments);
            if(mode=="appcontainer") {
                int hr=DeriveAppContainerSidFromAppContainerName(appName,out sid); if(hr<0) Marshal.ThrowExceptionForHR(hr);
                IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
                attrs=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attrs,1,0,ref size)); initialized=true;
                CAPS caps=new CAPS(); caps.sid=sid; cap=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(CAPS))); Marshal.StructureToPtr(caps,cap,false);
                Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20009),cap,new IntPtr(Marshal.SizeOf(typeof(CAPS))),IntPtr.Zero,IntPtr.Zero));
                SIX six=new SIX(); six.si=si; six.si.cb=Marshal.SizeOf(typeof(SIX)); six.attrs=attrs;
                Check(CreateProcess(exe,cmd,IntPtr.Zero,IntPtr.Zero,false,0x80000,IntPtr.Zero,cwd,ref six,out pi));
            } else {
                Check(OpenProcessToken(GetCurrentProcess(),0xF01FF,out original));
                Check(ConvertStringSidToSid(RestrictSid,out sid));
                SIDATTR restrict=new SIDATTR(); restrict.Sid=sid; entry=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SIDATTR))); Marshal.StructureToPtr(restrict,entry,false);
                bool writeRestricted=mode.StartsWith("restricted") || mode.StartsWith("desktop") || mode=="low";
                Check(CreateRestrictedToken(original,writeRestricted ? 1u|8u : 1u,0,IntPtr.Zero,0,IntPtr.Zero,writeRestricted ? 1u : 0u,writeRestricted ? entry : IntPtr.Zero,out token));
                if(mode.EndsWith("fixed")) {
                    string owner=System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
                    uint length; Check(ConvertStringSecurityDescriptorToSecurityDescriptor("D:(A;;GA;;;SY)(A;;GA;;;"+owner+")(A;;GA;;;"+RestrictSid+")",1,out sd,out length));
                    Check(SetKernelObjectSecurity(token,4,sd));
                    bool present,def; IntPtr acl; Check(GetSecurityDescriptorDacl(sd,out present,out acl,out def));
                    IntPtr ptr=Marshal.AllocHGlobal(IntPtr.Size);
                    try { Marshal.WriteIntPtr(ptr,acl); Check(SetTokenInformation(token,6,ptr,IntPtr.Size)); } finally { Marshal.FreeHGlobal(ptr); }
                    if(mode.StartsWith("desktop")) {
                        SA sa=new SA(); sa.size=Marshal.SizeOf(typeof(SA)); sa.sd=sd;
                        string name="clover_spike_"+Guid.NewGuid().ToString("N");
                        desktop=CreateDesktop(name,IntPtr.Zero,IntPtr.Zero,0,0x10000000,ref sa);
                        Check(desktop!=IntPtr.Zero); si.desktop=name;
                    }
                }
                if(mode=="low" || mode=="privileges-low") {
                    IntPtr low; Check(ConvertStringSidToSid("S-1-16-4096",out low));
                    try {
                        SIDATTR label=new SIDATTR(); label.Sid=low; label.Attributes=0x20;
                        Marshal.StructureToPtr(label,entry,false);
                        Check(SetTokenInformation(token,25,entry,Marshal.SizeOf(typeof(SIDATTR))+GetLengthSid(low)));
                    } finally { LocalFree(low); }
                }
                Check(CreateProcessAsUser(token,exe,cmd,IntPtr.Zero,IntPtr.Zero,false,0,IntPtr.Zero,cwd,ref si,out pi));
            }
            long launch=watch.ElapsedMilliseconds;
            bool timeout=WaitForSingleObject(pi.process,20000)==258;
            if(timeout) { TerminateProcess(pi.process,124); WaitForSingleObject(pi.process,2000); }
            uint exit; GetExitCodeProcess(pi.process,out exit);
            return "{\"mode\":\""+mode+"\",\"launch_ms\":"+launch+",\"elapsed_ms\":"+watch.ElapsedMilliseconds+",\"exit\":"+exit+",\"timeout\":"+timeout.ToString().ToLower()+"}";
        } finally {
            if(pi.thread!=IntPtr.Zero) CloseHandle(pi.thread); if(pi.process!=IntPtr.Zero) CloseHandle(pi.process);
            if(token!=IntPtr.Zero) CloseHandle(token); if(original!=IntPtr.Zero) CloseHandle(original);
            if(desktop!=IntPtr.Zero) CloseDesktop(desktop); if(sd!=IntPtr.Zero) LocalFree(sd);
            if(initialized) DeleteProcThreadAttributeList(attrs);
            if(attrs!=IntPtr.Zero) Marshal.FreeHGlobal(attrs); if(cap!=IntPtr.Zero) Marshal.FreeHGlobal(cap); if(entry!=IntPtr.Zero) Marshal.FreeHGlobal(entry);
            if(sid!=IntPtr.Zero) { if(mode=="appcontainer") FreeSid(sid); else LocalFree(sid); }
        }
    }
}
