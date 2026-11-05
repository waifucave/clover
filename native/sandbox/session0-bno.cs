// Disposable-VM compatibility diagnostic only. Production must resolve the real
// Session 0 object path; it must not install this temporary namespace alias.
using System;
using System.Runtime.InteropServices;
public static class CloverSessionZero {
 [StructLayout(LayoutKind.Sequential)] struct US { public ushort len,max; public IntPtr buf; }
 [StructLayout(LayoutKind.Sequential)] struct OA { public int len; public IntPtr root,name; public uint flags; public IntPtr sd,sqos; }
 [DllImport("ntdll.dll")] static extern int NtCreateDirectoryObject(out IntPtr handle,uint access,ref OA attr);
 [DllImport("ntdll.dll")] static extern int NtCreateSymbolicLinkObject(out IntPtr handle,uint access,ref OA attr,ref US target);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 static IntPtr directory=IntPtr.Zero,link=IntPtr.Zero;
 static US Text(string value) { US u=new US();u.len=(ushort)(value.Length*2);u.max=(ushort)(u.len+2);u.buf=Marshal.StringToHGlobalUni(value);return u; }
 public static string Open() {
  US name=Text(@"\Sessions\0"); IntPtr p=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(US)));
  try {
   Marshal.StructureToPtr(name,p,false);OA a=new OA();a.len=Marshal.SizeOf(typeof(OA));a.name=p;a.flags=0x40;
   int first=NtCreateDirectoryObject(out directory,0xF000F,ref a);
   Marshal.FreeHGlobal(name.buf);name=Text(@"\Sessions\0\BaseNamedObjects");Marshal.StructureToPtr(name,p,false);
   US target=Text(@"\BaseNamedObjects");
   try {int second=NtCreateSymbolicLinkObject(out link,0xF0001,ref a,ref target);return "directory_status=0x"+first.ToString("X8")+" alias_status=0x"+second.ToString("X8");}
   finally {Marshal.FreeHGlobal(target.buf);}
  } finally {Marshal.FreeHGlobal(name.buf);Marshal.FreeHGlobal(p);}
 }
 public static void Close(){if(link!=IntPtr.Zero){CloseHandle(link);link=IntPtr.Zero;}if(directory!=IntPtr.Zero){CloseHandle(directory);directory=IntPtr.Zero;}}
}
