cmake_minimum_required(VERSION 3.15)
project(BrowSdrHdRadio C)
set(CMAKE_C_STANDARD 11)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(ENABLE_FLOAT ON CACHE BOOL "" FORCE)
set(BUILD_TESTS OFF CACHE BOOL "" FORCE)
add_subdirectory(vendor/fftw fftw)
add_subdirectory(vendor/faad2 faad2)
set(NRSC vendor/nrsc5)
add_library(hd_decoder STATIC
    ${NRSC}/src/acquire.c ${NRSC}/src/decode.c ${NRSC}/src/frame.c
    ${NRSC}/src/here_images.c ${NRSC}/src/input.c ${NRSC}/src/output.c
    ${NRSC}/src/pids.c ${NRSC}/src/sync.c ${NRSC}/src/firdecim_cf32.c
    ${NRSC}/src/conv_dec.c ${NRSC}/src/rs_init.c ${NRSC}/src/rs_decode.c
    ${NRSC}/src/unicode.c ${NRSC}/src/browser_events.c wrapper.c)
target_include_directories(hd_decoder PRIVATE ${NRSC}/include ${NRSC}/src vendor/fftw/api vendor/faad2/include)
target_compile_definitions(hd_decoder PRIVATE _GNU_SOURCE HAVE_FAAD2 USE_FAAD2 HAVE_STRNDUP LIBRARY_DEBUG_LEVEL=5)
target_compile_options(hd_decoder PRIVATE -O3)
