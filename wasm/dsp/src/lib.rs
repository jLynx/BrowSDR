mod dsp;
mod fft;
mod processor;
mod channelizer;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod precision_tests;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

#[allow(unused_macros)]
macro_rules! console_log {
    ($($t:tt)*) => (log(&format_args!($($t)*).to_string()))
}

#[wasm_bindgen]
pub fn set_panic_hook() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn alloc_iq_buffer(capacity: usize) -> *mut i8 {
    let mut buf = vec![0i8; capacity];
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[wasm_bindgen]
pub fn free_iq_buffer(ptr: *mut i8, capacity: usize) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        let _ = Vec::from_raw_parts(ptr, capacity, capacity);
    }
}

/// Normalize full-scale signed int16 IQ into the existing float DSP input buffer.
/// Callers own both allocations and pass at most their allocated component count.
#[wasm_bindgen]
pub fn normalize_i16_to_f32(input: *const i16, output: *mut f32, count: usize) {
    let input = unsafe { std::slice::from_raw_parts(input, count) };
    let output = unsafe { std::slice::from_raw_parts_mut(output, count) };
    for (source, destination) in input.iter().zip(output) { *destination = *source as f32 / 32768.0; }
}

// Re-export WASM-bound types at crate root so wasm-bindgen finds them
pub use fft::FFT;
pub use processor::DspProcessor;
pub use channelizer::SharedChannelizer;

#[wasm_bindgen]
pub fn alloc_float_buffer(capacity: usize) -> *mut f32 {
    let mut buffer = vec![0.0f32; capacity];
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

// ============================================================================
// Wasm Tests (wasm-bindgen-test)
// ============================================================================
#[cfg(test)]
mod wasm_tests {
    use super::*;
    use wasm_bindgen_test::wasm_bindgen_test;

    #[wasm_bindgen_test]
    fn test_fft_construction_wasm() {
        let n = 8;
        let window = vec![1.0; n];
        let _fft = FFT::new(n, &window);
    }

    #[wasm_bindgen_test]
    fn test_fft_processing_wasm() {
        let n = 8;
        let window = vec![1.0; n];
        let mut fft = FFT::new(n, &window);

        let mut input = vec![0i8; n * 2];
        for i in 0..n {
            input[i * 2] = 64;
            input[i * 2 + 1] = 0;
        }

        let mut result = vec![0.0f32; n];
        fft.fft(&input, &mut result);

        // Verify the result size is correct
        assert_eq!(result.len(), n);
    }
}
