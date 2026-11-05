// Public-fixture handle propagation/duplication probe, never a production launcher.
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Security.Principal;
using System.Reflection;
using System.Runtime.InteropServices;
public static class CloverHandleProbe {
 [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct SI { public int cb; public string reserved,desktop,title; public int x,y,w,h,xc,yc,fill,flags; public short show,reserved2; public IntPtr extra,stdin,stdout,stderr; }
 [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread;public int pid,tid; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string name,uint access,uint share,ref SA security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint options);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(IntPtr file,byte[] bytes,uint count,out uint read,IntPtr overlapped);
 [DllImport("kernel32.dll")] static extern uint GetFileType(IntPtr file);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFilePointerEx(IntPtr file,long offset,out long position,uint method);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint time);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint exit);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll")] static extern bool IsTokenRestricted(IntPtr token);
 [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr reserved,uint flags);
 [DllImport("ole32.dll")] static extern int CoCreateInstance(ref Guid clsid,IntPtr outer,uint context,ref Guid iid,out IntPtr instance);
 static bool Matches(IntPtr file,string expected) {
  if(GetFileType(file)!=1)return false;
  long pos;SetFilePointerEx(file,0,out pos,0);byte[] buffer=new byte[256];uint read;
  return ReadFile(file,buffer,(uint)buffer.Length,out read,IntPtr.Zero) && Encoding.UTF8.GetString(buffer,0,(int)read)==expected;
 }
 static string Bool(bool value) {return value?"true":"false";}
 static string Quote(string value) {
  StringBuilder r=new StringBuilder("\"");int slashes=0;
  foreach(char c in value) {if(c=='\\'){slashes++;continue;}if(c=='\"'){r.Append('\\',slashes*2+1);r.Append(c);}else{r.Append('\\',slashes);r.Append(c);}slashes=0;}
  r.Append('\\',slashes*2);r.Append('"');return r.ToString();
 }
 public static int Main(string[] args) {
  if(args[0]=="local-com") {
   CoInitializeEx(IntPtr.Zero,0);Guid clsid=Type.GetTypeFromProgID("Shell.Application").GUID;
   Guid iid=new Guid("00020400-0000-0000-C000-000000000046");IntPtr instance;
   int hr=CoCreateInstance(ref clsid,IntPtr.Zero,4,ref iid,out instance);
   if(hr<0){Console.WriteLine("{\"co_create_hresult\":"+hr+",\"local_server_only\":true}");return 74;}
   object shell=Marshal.GetObjectForIUnknown(instance);Marshal.Release(instance);
   try {
    shell.GetType().InvokeMember("ShellExecute",BindingFlags.InvokeMethod,null,shell,new object[]{args[1],args[2],args[3],"open",0});
    Console.WriteLine("{\"co_create_hresult\":0,\"call_accepted\":true,\"local_server_only\":true}");return 0;
   }catch(Exception e){Console.WriteLine("{\"call_hresult\":"+e.HResult+",\"local_server_only\":true}");return 75;}
   finally{Marshal.FinalReleaseComObject(shell);}
  }
  if(args[0]=="hold") {
   // The trusted holder deliberately leaks two inheritable handles into the first
   // broker hop. The tested sandbox runner must remove them before its child.
   SA sa=new SA();sa.length=Marshal.SizeOf(typeof(SA));sa.inherit=true;
   IntPtr file=CreateFile(args[1],0x80000000,7,ref sa,3,0,IntPtr.Zero);
   if(file==new IntPtr(-1)) return 70;
   IntPtr process=OpenProcess(0x40|0x1000,true,Process.GetCurrentProcess().Id);if(process==IntPtr.Zero){CloseHandle(file);return 71;}
   PI pi=new PI();
   try {
    string[] argv=File.ReadAllLines(args[2]);for(int i=0;i<argv.Length;i++)argv[i]=Encoding.UTF8.GetString(Convert.FromBase64String(argv[i])).Replace("@PID@",Process.GetCurrentProcess().Id.ToString()).Replace("@FILE@",file.ToInt64().ToString()).Replace("@PROCESS@",process.ToInt64().ToString());
    StringBuilder cmd=new StringBuilder();foreach(string a in argv){if(cmd.Length>0)cmd.Append(' ');cmd.Append(Quote(a));}
    SI si=new SI();si.cb=Marshal.SizeOf(typeof(SI));
    if(!CreateProcess(argv[0],cmd,IntPtr.Zero,IntPtr.Zero,true,0x08000000,IntPtr.Zero,args[3],ref si,out pi))return 72;
    if(WaitForSingleObject(pi.process,25000)==258){TerminateProcess(pi.process,124);return 124;}
    uint code;GetExitCodeProcess(pi.process,out code);return (int)code;
   }finally{if(pi.process!=IntPtr.Zero)CloseHandle(pi.process);if(pi.thread!=IntPtr.Zero)CloseHandle(pi.thread);CloseHandle(process);CloseHandle(file);}
  }
  if(args[0]=="child") {
   int pid=int.Parse(args[1]);IntPtr raw=new IntPtr(long.Parse(args[2])),parent=new IntPtr(long.Parse(args[3]));string expected=args[5];
   bool direct=Matches(raw,expected),inheritedDup=false,openedDup=false;int inheritedError=0,openError=0;
   IntPtr duplicate;
   if(DuplicateHandle(parent,raw,GetCurrentProcess(),out duplicate,0,false,2)){inheritedDup=Matches(duplicate,expected);CloseHandle(duplicate);}else inheritedError=Marshal.GetLastWin32Error();
   IntPtr opened=OpenProcess(0x40,false,pid);
   if(opened!=IntPtr.Zero){if(DuplicateHandle(opened,raw,GetCurrentProcess(),out duplicate,0,false,2)){openedDup=Matches(duplicate,expected);CloseHandle(duplicate);}CloseHandle(opened);}else openError=Marshal.GetLastWin32Error();
   IntPtr token;bool restricted=false;if(OpenProcessToken(GetCurrentProcess(),8,out token)){restricted=IsTokenRestricted(token);CloseHandle(token);}
   bool admin=new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
   File.WriteAllText(args[4],"{\"inherited_canary_read\":"+Bool(direct)+",\"inherited_process_duplicate\":"+Bool(inheritedDup)+",\"open_process_duplicate\":"+Bool(openedDup)+",\"inherited_duplicate_error\":"+inheritedError+",\"open_process_error\":"+openError+",\"child_admin\":"+Bool(admin)+",\"child_restricted\":"+Bool(restricted)+"}");return 0;
  }
  return 73;
 }
}
