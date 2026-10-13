cmake_minimum_required(VERSION 3.12) # Specify a modern CMake version

# External artifacts (2026-10-08): compiler state must stay outside source.
get_filename_component(GXR_SOURCE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." REALPATH)
get_filename_component(GXR_BINARY_ROOT "${CMAKE_BINARY_DIR}" REALPATH)
string(FIND "${GXR_BINARY_ROOT}/" "${GXR_SOURCE_ROOT}/" GXR_IN_SOURCE)
if(GXR_IN_SOURCE EQUAL 0)
    message(FATAL_ERROR "Use an external build directory: cmake -S GalaxyXRDriver -B ../builds/GalaxyXR-Driver/build/cmake")
endif()
project(MyProject LANGUAGES CXX)

# Find all .cpp files in the src directory and store them in a variable
file(GLOB_RECURSE SOURCE_FILES "src/*.cpp")

# Add a library target using all the found source files
ADD_LIBRARY(driver_GalaxyXRDriver SHARED ${SOURCE_FILES} ../ThirdParty/easywsclient/easywsclient.cpp)

target_include_directories(driver_GalaxyXRDriver PUBLIC ../ThirdParty/json/include)
target_include_directories(driver_GalaxyXRDriver PUBLIC ../ThirdParty/openvr/headers)

set_target_properties(driver_GalaxyXRDriver PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON)

add_custom_command(TARGET driver_GalaxyXRDriver POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E rm -rf GalaxyXRDriver
    COMMAND ${CMAKE_COMMAND} -E make_directory GalaxyXRDriver/bin/linux64
    COMMAND ${CMAKE_COMMAND} -E copy_directory ${CMAKE_CURRENT_SOURCE_DIR}/DriverFiles GalaxyXRDriver
    COMMAND ${CMAKE_COMMAND} -E copy $<TARGET_FILE:driver_GalaxyXRDriver> GalaxyXRDriver/bin/linux64/driver_CustomHeadsetOpenVR.so
)

# cmake -S GalaxyXRDriver -B ../builds/GalaxyXR-Driver/build/cmake
# cmake --build ../builds/GalaxyXR-Driver/build/cmake --parallel
