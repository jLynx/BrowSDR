use crate::{FFT, SharedChannelizer, normalize_i16_to_f32};

#[test]
fn fft_preserves_fine_iq_and_matches_float_and_byte_scaling() {
    let n = 8192;
    let mut fft = FFT::new(n, &vec![1.0; n]);
    let fine: Vec<i16> = (0..n).flat_map(|_| [16, 0]).collect();
    let mut full = vec![0.0; n];
    let mut float = vec![0.0; n];
    fft.fft_i16(&fine, &mut full);
    let fine_float: Vec<f32> = fine.iter().map(|value| *value as f32 / 32768.0).collect();
    fft.fft_f32(&fine_float, &mut float);
    assert_eq!(full, float);
    assert!((full[n / 2] - 20.0 * (16.0f32 / 32768.0).log10()).abs() < 0.001);
    let bytes: Vec<i8> = fine.iter().map(|value| (*value >> 8) as i8).collect();
    let mut small = vec![0.0; n];
    fft.fft(&bytes, &mut small);
    assert_eq!(small[n / 2], -200.0);
}

#[test]
fn channelizer_formats_match_across_irregular_chunks() {
    let input: Vec<i8> = (0..65536).map(|index| ((index * 37) % 255 - 127) as i8).collect();
    let words: Vec<i16> = input.iter().map(|value| (*value as i16) << 8).collect();
    let floats: Vec<f32> = input.iter().map(|value| *value as f32 / 128.0).collect();
    let mut byte = SharedChannelizer::new(16, &[0, 256]);
    let mut word = SharedChannelizer::new(16, &[0, 256]);
    let mut float = SharedChannelizer::new(16, &[0, 256]);
    for start in (0..input.len()).step_by(1026) {
        let end = (start + 1026).min(input.len());
        byte.process(&input[start..end]);
        word.process_i16(&words[start..end]);
        float.process_f32(&floats[start..end]);
        for band in 0..2 {
            let count = byte.output_len(band);
            assert_eq!(count, word.output_len(band));
            assert_eq!(count, float.output_len(band));
            unsafe {
                assert_eq!(std::slice::from_raw_parts(byte.output_ptr(band), count), std::slice::from_raw_parts(word.output_ptr(band), count));
                assert_eq!(std::slice::from_raw_parts(byte.output_ptr(band), count), std::slice::from_raw_parts(float.output_ptr(band), count));
            }
        }
    }
}

#[test]
fn normalization_keeps_signed_boundaries_and_low_bits() {
    let input = [-32768i16, -32767, -1, 0, 1, 16, 32767];
    let mut output = [0.0f32; 7];
    normalize_i16_to_f32(input.as_ptr(), output.as_mut_ptr(), input.len());
    assert_eq!(output, input.map(|value| value as f32 / 32768.0));
}
