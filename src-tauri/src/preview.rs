//! Backend support for the preview pane: bounded text reads and shell thumbnails.
//! Images, audio, video, PDF and 3D are streamed to the webview over the asset protocol.

use std::fs::File;
use std::io::Read;

use serde::Serialize;

/// How much of a file is inspected when deciding whether it is text.
const SNIFF_BYTES: usize = 8 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPreview {
    pub text: String,
    pub encoding: &'static str,
    /// Only the first `max_bytes` of the file were read.
    pub truncated: bool,
    /// The file looks binary; `text` is empty.
    pub binary: bool,
}

pub fn read_text(path: &str, max_bytes: usize) -> Result<TextPreview, String> {
    let file = File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let mut bytes = Vec::new();
    // One byte past the limit tells a file of exactly `max_bytes` apart from a longer one.
    file.take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("{path}: {e}"))?;
    let truncated = bytes.len() > max_bytes;
    bytes.truncate(max_bytes);
    Ok(decode(&bytes, truncated))
}

fn decode(bytes: &[u8], truncated: bool) -> TextPreview {
    let done = |text: String, encoding| TextPreview {
        text,
        encoding,
        truncated,
        binary: false,
    };
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return done(utf16(rest, u16::from_le_bytes), "UTF-16 LE");
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return done(utf16(rest, u16::from_be_bytes), "UTF-16 BE");
    }
    if looks_binary(bytes) {
        return TextPreview {
            text: String::new(),
            encoding: "",
            truncated,
            binary: true,
        };
    }
    let (body, encoding) = match bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        Some(rest) => (rest, "UTF-8 BOM"),
        None => (bytes, "UTF-8"),
    };
    match std::str::from_utf8(body) {
        Ok(s) => done(s.to_owned(), encoding),
        // The read limit can split a multi-byte character; that isn't an encoding problem.
        Err(e) if truncated && e.error_len().is_none() => done(
            String::from_utf8_lossy(&body[..e.valid_up_to()]).into_owned(),
            encoding,
        ),
        Err(_) => done(windows_1252(body), "Windows-1252"),
    }
}

fn utf16(bytes: &[u8], to_unit: fn([u8; 2]) -> u16) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| to_unit([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

fn looks_binary(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(SNIFF_BYTES)];
    if sample.contains(&0) {
        return true;
    }
    let control = sample
        .iter()
        .filter(|&&b| b < 0x20 && !matches!(b, b'\t' | b'\n' | b'\r' | 0x0C | 0x1B))
        .count();
    control * 10 > sample.len()
}

/// The 0x80-0x9F range is the only part of Windows-1252 that differs from Latin-1.
const CP1252_HIGH: [char; 32] = [
    '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8D}', 'Ž', '\u{8F}',
    '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9D}', 'ž', 'Ÿ',
];

fn windows_1252(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| match b {
            0x80..=0x9F => CP1252_HIGH[(b - 0x80) as usize],
            _ => b as char,
        })
        .collect()
}

// ---------------------------------------------------------------- thumbnails

/// PNG of the thumbnail Windows has for this file, from whichever shell handler claims it
/// (photos, video frames, album art, Office documents, codecs the webview lacks...).
#[cfg(windows)]
pub fn thumbnail(path: &str, size: i32) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::DeleteObject;
    use windows::Win32::System::Com::{
        COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize,
    };
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK,
        SIIGBF_RESIZETOFIT, SIIGBF_THUMBNAILONLY,
    };
    use windows::core::HSTRING;

    struct ComGuard;
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    // SAFETY: COM is initialised and released on this thread around the shell calls, and the
    // bitmap GetImage hands over is owned here until DeleteObject.
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE)
            .ok()
            .map_err(|e| e.to_string())?;
        let _com = ComGuard;
        let factory: IShellItemImageFactory =
            SHCreateItemFromParsingName(&HSTRING::from(path), None).map_err(|e| e.to_string())?;
        // THUMBNAILONLY: fail instead of returning a blurry upscaled file icon. The UI has its own.
        let bitmap = factory
            .GetImage(
                SIZE { cx: size, cy: size },
                SIIGBF_RESIZETOFIT | SIIGBF_BIGGERSIZEOK | SIIGBF_THUMBNAILONLY,
            )
            .map_err(|e| e.to_string())?;
        let result = bitmap_to_png(bitmap);
        let _ = DeleteObject(bitmap.into());
        result
    }
}

#[cfg(windows)]
unsafe fn bitmap_to_png(bitmap: windows::Win32::Graphics::Gdi::HBITMAP) -> Result<Vec<u8>, String> {
    use windows::Win32::Graphics::Gdi::{
        BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC,
        GetDIBits, GetObjectW,
    };

    let mut info = BITMAP::default();
    let got = unsafe {
        GetObjectW(
            bitmap.into(),
            size_of::<BITMAP>() as i32,
            Some((&raw mut info).cast()),
        )
    };
    if got == 0 || info.bmWidth <= 0 || info.bmHeight == 0 {
        return Err("Thumbnail bitmap is unreadable".into());
    }
    let (width, height) = (info.bmWidth, info.bmHeight.abs());

    let mut header = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height, // negative = top-down rows
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut pixels = vec![0u8; width as usize * height as usize * 4];
    let rows = unsafe {
        let dc = CreateCompatibleDC(None);
        let rows = GetDIBits(
            dc,
            bitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr().cast()),
            &mut header,
            DIB_RGB_COLORS,
        );
        let _ = DeleteDC(dc);
        rows
    };
    if rows == 0 {
        return Err("Thumbnail bitmap is unreadable".into());
    }
    bgra_to_rgba(&mut pixels);
    encode_png(&pixels, width as u32, height as u32)
}

/// Converts premultiplied BGRA to straight RGBA. Handlers for formats without transparency
/// often leave alpha at zero, so an all-zero alpha channel means opaque.
#[cfg(any(windows, test))]
fn bgra_to_rgba(pixels: &mut [u8]) {
    let opaque = pixels.chunks_exact(4).all(|p| p[3] == 0);
    for p in pixels.chunks_exact_mut(4) {
        p.swap(0, 2);
        if opaque {
            p[3] = 255;
        } else if p[3] > 0 && p[3] < 255 {
            let a = p[3] as u32;
            for c in &mut p[..3] {
                *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
}

#[cfg(any(windows, test))]
fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::Fast);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(not(windows))]
pub fn thumbnail(_path: &str, _size: i32) -> Result<Vec<u8>, String> {
    Err("Thumbnails are not available on this platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_each_encoding() {
        assert_eq!(decode(b"plain", false).encoding, "UTF-8");
        assert_eq!(decode("h\u{e9}llo".as_bytes(), false).text, "h\u{e9}llo");

        let bom = decode(b"\xEF\xBB\xBFhi", false);
        assert_eq!((bom.text.as_str(), bom.encoding), ("hi", "UTF-8 BOM"));

        let le = decode(b"\xFF\xFEh\0i\0", false);
        assert_eq!((le.text.as_str(), le.encoding), ("hi", "UTF-16 LE"));
        let be = decode(b"\xFE\xFF\0h\0i", false);
        assert_eq!((be.text.as_str(), be.encoding), ("hi", "UTF-16 BE"));

        let legacy = decode(b"caf\xE9 \x80", false);
        assert_eq!(
            (legacy.text.as_str(), legacy.encoding),
            ("caf\u{e9} \u{20ac}", "Windows-1252")
        );
    }

    #[test]
    fn truncation_inside_a_character_stays_utf8() {
        // First byte of a two-byte character, cut by the read limit.
        let cut = decode(b"abc\xC3", true);
        assert_eq!((cut.text.as_str(), cut.encoding), ("abc", "UTF-8"));
        // The same bytes in a complete file are not valid UTF-8.
        assert_eq!(decode(b"abc\xC3", false).encoding, "Windows-1252");
    }

    #[test]
    fn detects_binary() {
        assert!(decode(b"MZ\x90\0\x03\0\0\0", false).binary);
        assert!(decode(&[1, 2, 3, 4, 5, 6, 7, 8, 65, 66], false).binary);
        assert!(!decode(b"line one\r\n\tline two\n", false).binary);
        assert!(!decode(b"", false).binary);
    }

    #[test]
    fn read_text_reports_truncation() {
        let path = std::env::temp_dir().join(format!("vault_preview_{}.txt", std::process::id()));
        std::fs::write(&path, b"0123456789").unwrap();
        let p = path.to_str().unwrap();

        let cut = read_text(p, 4).unwrap();
        assert_eq!((cut.text.as_str(), cut.truncated), ("0123", true));
        let exact = read_text(p, 10).unwrap();
        assert_eq!(
            (exact.text.as_str(), exact.truncated),
            ("0123456789", false)
        );

        std::fs::remove_file(&path).unwrap();
        assert!(read_text(p, 4).is_err());
    }

    #[test]
    fn converts_thumbnail_pixels() {
        // BGRA blue pixel, alpha left at zero by the handler: treated as opaque.
        let mut flat = [255, 0, 0, 0];
        bgra_to_rgba(&mut flat);
        assert_eq!(flat, [0, 0, 255, 255]);

        // Half-transparent premultiplied red alongside a fully transparent pixel.
        let mut mixed = [0, 0, 128, 128, 0, 0, 0, 0];
        bgra_to_rgba(&mut mixed);
        assert_eq!(mixed, [255, 0, 0, 128, 0, 0, 0, 0]);

        let png = encode_png(&mixed, 2, 1).unwrap();
        assert_eq!(&png[1..4], b"PNG");
    }
}
