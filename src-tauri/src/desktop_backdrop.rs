use std::{cell::RefCell, sync::atomic::{AtomicBool, Ordering}};
use windows::{
    core::Interface,
    System::{DispatcherQueue, DispatcherQueueController},
    UI::Composition::{Compositor, CompositionRoundedRectangleGeometry, SpriteVisual, Desktop::DesktopWindowTarget},
    Win32::{Foundation::HWND, Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_SYSTEMBACKDROP_TYPE, DWMWA_USE_HOSTBACKDROPBRUSH},
        System::WinRT::{Composition::ICompositorDesktopInterop, CreateDispatcherQueueController, DispatcherQueueOptions, DQTYPE_THREAD_CURRENT, DQTAT_COM_NONE}},
};
use windows_numerics::Vector2;

// All composition objects stay on the window's UI thread. Unlike window-wide
// Acrylic, this visual has its own antialiased, rounded clip for the backdrop.
struct Scene {
    _queue: Option<DispatcherQueueController>,
    _compositor: Compositor,
    _target: DesktopWindowTarget,
    visual: SpriteVisual,
    geometry: CompositionRoundedRectangleGeometry,
}
thread_local! { static SCENE: RefCell<Option<Scene>> = const { RefCell::new(None) }; }
static ENABLED: AtomicBool = AtomicBool::new(false);
pub fn enabled() -> bool { ENABLED.load(Ordering::Relaxed) }

impl Scene {
    fn create(hwnd: HWND) -> windows::core::Result<Self> {
        let queue = if DispatcherQueue::GetForCurrentThread().is_ok() { None } else { Some(unsafe {
            CreateDispatcherQueueController(DispatcherQueueOptions {
                dwSize: std::mem::size_of::<DispatcherQueueOptions>() as u32,
                threadType: DQTYPE_THREAD_CURRENT, apartmentType: DQTAT_COM_NONE,
            })?
        }) };
        let yes = 1i32;
        unsafe { DwmSetWindowAttribute(hwnd, DWMWA_USE_HOSTBACKDROPBRUSH, &yes as *const _ as _, 4)?; }
        let compositor = Compositor::new()?;
        let target = unsafe { compositor.cast::<ICompositorDesktopInterop>()?.CreateDesktopWindowTarget(hwnd, false)? };
        let visual = compositor.CreateSpriteVisual()?;
        visual.SetRelativeSizeAdjustment(Vector2 { X:1.0, Y:1.0 })?;
        visual.SetBrush(&compositor.CreateHostBackdropBrush()?)?;
        let geometry = compositor.CreateRoundedRectangleGeometry()?;
        visual.SetClip(&compositor.CreateGeometricClipWithGeometry(&geometry)?)?;
        target.SetRoot(&visual)?;
        Ok(Self {_queue:queue,_compositor:compositor,_target:target,visual,geometry})
    }
}
pub fn apply(raw: windows_sys::Win32::Foundation::HWND, enable: bool) -> bool {
    let hwnd = HWND(raw);
    let none = 1i32;
    unsafe { let _ = DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, &none as *const _ as _, 4); }
    let result = SCENE.with(|slot| -> windows::core::Result<()> {
        let mut state=slot.borrow_mut();
        if enable && state.is_none() { *state=Some(Scene::create(hwnd)?); }
        if let Some(scene)=state.as_ref() { scene.visual.SetIsVisible(enable)?; }
        Ok(())
    });
    ENABLED.store(enable && result.is_ok(),Ordering::Relaxed);
    if let Err(error)=&result { eprintln!("Desktop backdrop: {error}"); }
    result.is_ok()
}
pub fn clip(_hwnd: windows_sys::Win32::Foundation::HWND, width:i32, height:i32, diameter:i32) {
    SCENE.with(|slot| {
        if let Ok(state)=slot.try_borrow(){if let Some(scene)=state.as_ref() {
            let _=scene.geometry.SetSize(Vector2 {X:width as f32,Y:height as f32});
            let radius=diameter as f32/2.0;
            let _=scene.geometry.SetCornerRadius(Vector2 {X:radius,Y:radius});
        }}
    });
}
