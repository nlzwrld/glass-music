use serde_json::{json,Value};
use std::sync::atomic::{AtomicBool,AtomicI32,Ordering};
use windows_sys::Win32::{
 Foundation::{HWND,RECT,POINT,WPARAM,LPARAM,LRESULT},
 Graphics::{Gdi::{ClientToScreen,CreateRectRgn,CreateRoundRectRgn,DeleteObject,EqualRgn,GetWindowRgn,PtInRegion,SetWindowRgn},Dwm::{DwmGetWindowAttribute,DwmSetWindowAttribute,DWMWA_SYSTEMBACKDROP_TYPE,DWMWA_BORDER_COLOR,DWMWA_WINDOW_CORNER_PREFERENCE}},
 UI::{Shell::{SetWindowSubclass,DefSubclassProc,RemoveWindowSubclass},HiDpi::GetDpiForWindow,WindowsAndMessaging::{GetClientRect,GetWindowLongPtrW,GetWindowRect,IsWindowVisible,IsIconic,IsZoomed,SetWindowLongPtrW,SetWindowPos,GWL_STYLE,GWL_EXSTYLE,WS_CAPTION,WS_THICKFRAME,WS_EX_WINDOWEDGE,WS_EX_CLIENTEDGE,WS_EX_STATICEDGE,WS_EX_DLGMODALFRAME,SWP_FRAMECHANGED,SWP_NOMOVE,SWP_NOSIZE,SWP_NOACTIVATE,SWP_NOZORDER,WM_STYLECHANGING,WM_NCPAINT,WM_NCACTIVATE,WM_NCDESTROY,WM_WINDOWPOSCHANGED,WM_DPICHANGED,WM_SHOWWINDOW,STYLESTRUCT}}
};
const SUBCLASS_ID:usize=0x474c4153;
pub fn attach(hwnd:HWND){unsafe{SetWindowSubclass(hwnd,Some(procedure),SUBCLASS_ID,0);}apply(hwnd,unsafe{GetDpiForWindow(hwnd)} as f64/96.0);}
unsafe extern "system" fn procedure(hwnd:HWND,msg:u32,wp:WPARAM,lp:LPARAM,_id:usize,_data:usize)->LRESULT{
 if msg==WM_STYLECHANGING&&!APPLYING.load(Ordering::Acquire)&&lp!=0{
  let styles=&mut *(lp as *mut STYLESTRUCT);
  if wp as i32==GWL_STYLE{styles.styleNew&=!WS_CAPTION;}
  if wp as i32==GWL_EXSTYLE{styles.styleNew&=!(WS_EX_WINDOWEDGE|WS_EX_CLIENTEDGE|WS_EX_STATICEDGE|WS_EX_DLGMODALFRAME);}
 }
 if msg==WM_NCPAINT{return 0;}
 if msg==WM_NCACTIVATE{return DefSubclassProc(hwnd,msg,wp,-1);}
 if msg==WM_NCDESTROY{RemoveWindowSubclass(hwnd,Some(procedure),SUBCLASS_ID);}
 let result=DefSubclassProc(hwnd,msg,wp,lp);
 if [WM_WINDOWPOSCHANGED,WM_DPICHANGED,WM_SHOWWINDOW].contains(&msg){apply(hwnd,GetDpiForWindow(hwnd) as f64/96.0);}
 result
}
pub fn visible(hwnd:HWND)->bool{unsafe{IsWindowVisible(hwnd)!=0&&IsIconic(hwnd)==0}}

// Win32 frame/region changes may send size events synchronously. Guard reentry.
// Compare the actual region, so a framework style update cannot invalidate a cache.
static APPLYING:AtomicBool=AtomicBool::new(false);
static BORDER_RESULT:AtomicI32=AtomicI32::new(-1);
struct ApplyGuard;
impl Drop for ApplyGuard{fn drop(&mut self){APPLYING.store(false,Ordering::Release);}}
pub fn apply(hwnd:HWND,scale:f64){
 if APPLYING.swap(true,Ordering::AcqRel){return;}let _guard=ApplyGuard;
 unsafe{
  // Tao retains WS_CAPTION even on an undecorated HWND. Keep WS_THICKFRAME
  // for resizing/snap. Windows may retain WS_EX_WINDOWEDGE with that style;
  // do not repeatedly trigger FRAMECHANGED trying to clear that structural bit.
  let style=GetWindowLongPtrW(hwnd,GWL_STYLE);let bare=style&!(WS_CAPTION as isize);
  if style!=bare{
   SetWindowLongPtrW(hwnd,GWL_STYLE,bare);
   SetWindowPos(hwnd,std::ptr::null_mut(),0,0,0,0,SWP_FRAMECHANGED|SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE|SWP_NOZORDER);
  }
  // The region owns the shape; DWM must not add another corner treatment.
  let no_border:u32=0xfffffffe;let rounded:u32=1;
  BORDER_RESULT.store(DwmSetWindowAttribute(hwnd,DWMWA_BORDER_COLOR as u32,&no_border as *const _ as _,4),Ordering::Relaxed);
  let _=DwmSetWindowAttribute(hwnd,DWMWA_WINDOW_CORNER_PREFERENCE as u32,&rounded as *const _ as _,4);
  let mut rect:RECT=std::mem::zeroed();if GetWindowRect(hwnd,&mut rect)==0{return;}
  let w=rect.right-rect.left;let h=rect.bottom-rect.top;if w<2||h<2{return;}
  // Maximized HWND bounds can extend past the monitor by a resize inset.
  // Clip to the CLIENT rectangle; when maximized, remove corner rounding completely.
  let mut client:RECT=std::mem::zeroed();let mut origin=POINT{x:0,y:0};
  if GetClientRect(hwnd,&mut client)==0||ClientToScreen(hwnd,&mut origin)==0{return;}
  let x=origin.x-rect.left;let y=origin.y-rect.top;
  let zoomed=IsZoomed(hwnd)!=0;
  let diameter=if zoomed { 0 } else { (20.0*scale).round() as i32 };
  crate::desktop_backdrop::clip(hwnd,client.right,client.bottom,diameter);
  let desired=if zoomed {
   CreateRectRgn(x,y,x+client.right+1,y+client.bottom+1)
  } else {
   CreateRoundRectRgn(x,y,x+client.right+1,y+client.bottom+1,diameter,diameter)
  };
  if desired.is_null(){return;}
  let actual=CreateRectRgn(0,0,0,0);
  let equal=!actual.is_null()&&GetWindowRgn(hwnd,actual)>1&&EqualRgn(actual,desired)!=0;
  if !actual.is_null(){DeleteObject(actual);}
  if equal{DeleteObject(desired);return;}
  // Windows owns a successful region; only delete it ourselves on failure.
  if SetWindowRgn(hwnd,desired,1)==0{DeleteObject(desired);}
 }
}
pub fn inspect(hwnd:HWND)->Value{
 unsafe{
  let mut rect:RECT=std::mem::zeroed();if GetWindowRect(hwnd,&mut rect)==0{return json!({"nativeRegion":false});}
  let w=rect.right-rect.left;let h=rect.bottom-rect.top;let region=CreateRectRgn(0,0,0,0);
  if region.is_null(){return json!({"nativeRegion":false});}
  let kind=GetWindowRgn(hwnd,region);let contains=|x,y|PtInRegion(region,x,y)!=0;
  let mut client:RECT=std::mem::zeroed();let mut origin=POINT{x:0,y:0};GetClientRect(hwnd,&mut client);ClientToScreen(hwnd,&mut origin);
  let style=GetWindowLongPtrW(hwnd,GWL_STYLE) as u32;let ex=GetWindowLongPtrW(hwnd,GWL_EXSTYLE) as u32;
  let mut backdrop:u32=0;let backdrop_result=DwmGetWindowAttribute(hwnd,DWMWA_SYSTEMBACKDROP_TYPE as u32,&mut backdrop as *mut _ as _,4);
  let value=json!({"systemBackdrop":backdrop,"backdropReadResult":backdrop_result,"nativeRegion":kind>1,"width":w,"height":h,"maximized":IsZoomed(hwnd)!=0,"clientInsets":[origin.x-rect.left,origin.y-rect.top,rect.right-origin.x-client.right,rect.bottom-origin.y-client.bottom],"corners":[contains(0,0),contains(w-1,0),contains(0,h-1),contains(w-1,h-1)],"clientCorners":[contains(origin.x-rect.left,origin.y-rect.top),contains(origin.x-rect.left+client.right-1,origin.y-rect.top),contains(origin.x-rect.left,origin.y-rect.top+client.bottom-1),contains(origin.x-rect.left+client.right-1,origin.y-rect.top+client.bottom-1)],"center":contains(w/2,h/2),"sideMidpoints":[contains(0,h/2),contains(w/2,0),contains(w-1,h/2),contains(w/2,h-1)],"frame":{"caption":style&WS_CAPTION!=0,"resizeStyle":style&WS_THICKFRAME!=0,"extendedEdge":ex&(WS_EX_WINDOWEDGE|WS_EX_CLIENTEDGE|WS_EX_STATICEDGE|WS_EX_DLGMODALFRAME)!=0,"dwmBorderSuppressed":BORDER_RESULT.load(Ordering::Relaxed)>=0,"borderSetResult":BORDER_RESULT.load(Ordering::Relaxed),"style":style,"extendedStyle":ex}});
  DeleteObject(region);value
 }
}
