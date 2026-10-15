#include "Config.h"
Config driverConfig = {};
Config driverConfigOld = {};
Config defaultDriverConfig = {};
std::mutex driverConfigLock;
std::string driverVersion = "1.9.0-dev.7";