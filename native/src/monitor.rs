use serde::Serialize;
use std::{mem::size_of, ptr};
use windows_sys::Win32::{
    Devices::Display::{
        DestroyPhysicalMonitors, GetMonitorBrightness, GetNumberOfPhysicalMonitorsFromHMONITOR,
        GetPhysicalMonitorsFromHMONITOR, GetVCPFeatureAndVCPFeatureReply, PHYSICAL_MONITOR,
        SetMonitorBrightness, SetVCPFeature,
    },
    Foundation::{HANDLE, LPARAM, RECT},
    Graphics::Gdi::{
        DISPLAY_DEVICE_ACTIVE, DISPLAY_DEVICEW, EnumDisplayDevicesW, EnumDisplayMonitors,
        GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW,
    },
    System::Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_BINARY, RegGetValueW},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Brightness {
    pub percent: f64,
    pub current: u32,
    pub minimum: u32,
    pub maximum: u32,
    pub method: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Monitor {
    id: String,
    name: String,
    display: String,
    brightness: Option<Brightness>,
    error: Option<String>,
}

struct Physical(Vec<PHYSICAL_MONITOR>);
impl Drop for Physical {
    fn drop(&mut self) {
        // SAFETY: owns every handle returned by GetPhysicalMonitorsFromHMONITOR.
        unsafe {
            DestroyPhysicalMonitors(self.0.len() as u32, self.0.as_ptr());
        }
    }
}

fn wide(value: &[u16]) -> String {
    String::from_utf16_lossy(&value[..value.iter().position(|c| *c == 0).unwrap_or(value.len())])
}

fn edid_name(edid: &[u8]) -> Option<String> {
    if edid.len() < 128 || edid[..8] != [0, 255, 255, 255, 255, 255, 255, 0] {
        return None;
    }
    for block in edid[54..126].as_chunks::<18>().0 {
        if block[..5] == [0, 0, 0, 252, 0] {
            let name = String::from_utf8_lossy(&block[5..18])
                .trim_matches(['\0', '\n', '\r', ' '])
                .to_string();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

fn friendly_name(id: &str) -> Option<String> {
    let parts: Vec<_> = id.split('#').collect();
    if parts.len() != 4 {
        return None;
    }
    let path: Vec<u16> = format!(
        "SYSTEM\\CurrentControlSet\\Enum\\DISPLAY\\{}\\{}\\Device Parameters\0",
        parts[1], parts[2]
    )
    .encode_utf16()
    .collect();
    let value: Vec<u16> = "EDID\0".encode_utf16().collect();
    let mut bytes = [0u8; 4096];
    let mut size = bytes.len() as u32;
    // SAFETY: read-only registry query into a bounded buffer. No monitor communication.
    if unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            path.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_BINARY,
            ptr::null_mut(),
            bytes.as_mut_ptr().cast(),
            &mut size,
        )
    } != 0
    {
        return None;
    }
    edid_name(&bytes[..size as usize])
}

fn os_error(operation: &str) -> String {
    format!("{operation}: {}", std::io::Error::last_os_error())
}

unsafe extern "system" fn collect(handle: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> i32 {
    // SAFETY: data points at the vector owned by logical_monitors for this synchronous call.
    unsafe {
        (&mut *(data as *mut Vec<HMONITOR>)).push(handle);
    }
    1
}

fn logical_monitors() -> Result<Vec<HMONITOR>, String> {
    let mut handles = Vec::new();
    // SAFETY: callback and its vector remain valid throughout enumeration.
    if unsafe {
        EnumDisplayMonitors(
            ptr::null_mut(),
            ptr::null(),
            Some(collect),
            &mut handles as *mut _ as LPARAM,
        )
    } == 0
    {
        return Err(os_error("EnumDisplayMonitors"));
    }
    Ok(handles)
}

fn identity(handle: HMONITOR) -> Result<(String, String, String), String> {
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
    // SAFETY: initialized structures with their required sizes and valid pointers.
    if unsafe { GetMonitorInfoW(handle, &mut info.monitorInfo) } == 0 {
        return Err(os_error("GetMonitorInfoW"));
    }
    let mut devices = Vec::new();
    for index in 0..32 {
        let mut device = DISPLAY_DEVICEW {
            cb: size_of::<DISPLAY_DEVICEW>() as u32,
            ..Default::default()
        };
        // EDD_GET_DEVICE_INTERFACE_NAME = 1. Use interface identity, never DISPLAY1 numbering.
        if unsafe { EnumDisplayDevicesW(info.szDevice.as_ptr(), index, &mut device, 1) } == 0 {
            break;
        }
        if device.StateFlags & DISPLAY_DEVICE_ACTIVE != 0 {
            devices.push(device);
        }
    }
    if devices.len() != 1 {
        return Err(
            "Display identity is ambiguous (clone / virtual display); use extended desktop".into(),
        );
    }
    let id = wide(&devices[0].DeviceID).to_lowercase();
    if id.is_empty() {
        return Err("Monitor has no device interface identity".into());
    }
    let name = friendly_name(&id).unwrap_or_else(|| wide(&devices[0].DeviceString));
    Ok((id, name, wide(&info.szDevice)))
}

fn physical(handle: HMONITOR) -> Result<Physical, String> {
    let mut count = 0;
    // SAFETY: a current enumerated HMONITOR and valid output pointer.
    if unsafe { GetNumberOfPhysicalMonitorsFromHMONITOR(handle, &mut count) } == 0 {
        return Err(os_error("GetNumberOfPhysicalMonitorsFromHMONITOR"));
    }
    if count != 1 {
        return Err(format!(
            "Expected one physical monitor, found {count}; clone displays are unsupported"
        ));
    }
    let mut monitors = vec![PHYSICAL_MONITOR::default(); count as usize];
    // SAFETY: buffer contains count entries. Ownership is immediately transferred to RAII guard.
    if unsafe { GetPhysicalMonitorsFromHMONITOR(handle, count, monitors.as_mut_ptr()) } == 0 {
        return Err(os_error("GetPhysicalMonitorsFromHMONITOR"));
    }
    Ok(Physical(monitors))
}

fn reading(
    current: u32,
    minimum: u32,
    maximum: u32,
    method: &'static str,
) -> Result<Brightness, String> {
    if maximum <= minimum || current < minimum || current > maximum {
        return Err(format!(
            "Invalid brightness range: {minimum} <= {current} <= {maximum}"
        ));
    }
    Ok(Brightness {
        percent: (current - minimum) as f64 * 100.0 / (maximum - minimum) as f64,
        current,
        minimum,
        maximum,
        method,
    })
}

fn read(handle: HANDLE) -> Result<Brightness, String> {
    let (mut current, mut maximum, mut minimum) = (0, 0, 0);
    // SAFETY: live physical handle, valid output pointers; only brightness VCP 0x10 is queried.
    if unsafe {
        GetVCPFeatureAndVCPFeatureReply(handle, 0x10, ptr::null_mut(), &mut current, &mut maximum)
    } != 0
    {
        return reading(current, 0, maximum, "vcp");
    }
    if unsafe { GetMonitorBrightness(handle, &mut minimum, &mut current, &mut maximum) } != 0 {
        return reading(current, minimum, maximum, "highLevel");
    }
    Err(os_error(
        "Brightness unavailable (enable DDC/CI, check cable / HDR / sleep)",
    ))
}

pub fn list() -> Result<Vec<Monitor>, String> {
    let mut result = Vec::new();
    for handle in logical_monitors()? {
        match identity(handle) {
            Ok((id, name, display)) => {
                let reading = physical(handle).and_then(|p| read(p.0[0].hPhysicalMonitor));
                let (brightness, error) = match reading {
                    Ok(value) => (Some(value), None),
                    Err(e) => (None, Some(e)),
                };
                result.push(Monitor {
                    id,
                    name,
                    display,
                    brightness,
                    error,
                });
            }
            Err(error) => result.push(Monitor {
                id: String::new(),
                name: "Unsupported display".into(),
                display: String::new(),
                brightness: None,
                error: Some(error),
            }),
        }
    }
    Ok(result)
}

fn selected(id: &str) -> Result<Physical, String> {
    if id.is_empty() {
        return Err("Select a monitor first".into());
    }
    let mut matches = Vec::new();
    for handle in logical_monitors()? {
        if let Ok((candidate, _, _)) = identity(handle)
            && candidate == id
        {
            matches.push(handle);
        }
    }
    if matches.len() != 1 {
        return Err(
            "Selected monitor is disconnected or ambiguous; reconnect or select it again".into(),
        );
    }
    physical(matches[0])
}

pub fn get(id: &str) -> Result<Brightness, String> {
    let monitor = selected(id)?;
    read(monitor.0[0].hPhysicalMonitor)
}

fn raw_value(percent: f64, minimum: u32, maximum: u32) -> u32 {
    minimum + ((maximum - minimum) as f64 * percent / 100.0).round() as u32
}

pub fn set(id: &str, percent: f64) -> Result<Brightness, String> {
    let monitor = selected(id)?;
    let handle = monitor.0[0].hPhysicalMonitor;
    let before = read(handle)?;
    let value = raw_value(percent, before.minimum, before.maximum);
    // SAFETY: selected physical handle; value is within the range just read from the monitor.
    let ok = unsafe {
        if before.method == "vcp" {
            SetVCPFeature(handle, 0x10, value)
        } else {
            SetMonitorBrightness(handle, value)
        }
    };
    if ok == 0 {
        return Err(os_error("Set brightness"));
    }
    // Report actual readback, not an assumed successful target (HDR can ignore writes).
    std::thread::sleep(std::time::Duration::from_millis(80));
    read(handle)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_edid_name_and_rejects_short_data() {
        let mut edid = [0u8; 128];
        edid[..8].copy_from_slice(&[0, 255, 255, 255, 255, 255, 255, 0]);
        edid[54..59].copy_from_slice(&[0, 0, 0, 252, 0]);
        edid[59..72].copy_from_slice(b"GCQ271HA\n    ");
        assert_eq!(edid_name(&edid).as_deref(), Some("GCQ271HA"));
        assert!(edid_name(&[]).is_none());
    }
    #[test]
    fn normalizes_nonstandard_ranges() {
        assert_eq!(reading(60, 20, 100, "highLevel").unwrap().percent, 50.0);
        assert_eq!(raw_value(50.0, 20, 100), 60);
        assert_eq!(raw_value(0.0, 20, 100), 20);
        assert_eq!(raw_value(100.0, 20, 100), 100);
        assert_eq!(raw_value(50.0, 0, 255), 128);
    }
    #[test]
    fn invalid_hardware_ranges_are_rejected() {
        for (current, min, max) in [(0, 0, 0), (101, 0, 100), (9, 10, 100), (5, 10, 1)] {
            assert!(reading(current, min, max, "vcp").is_err());
        }
    }
}
