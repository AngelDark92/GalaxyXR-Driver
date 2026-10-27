#include "Config.h"
Config driverConfig = {};
Config driverConfigOld = {};
Config defaultDriverConfig = {};
std::mutex driverConfigLock;
std::string driverVersion = "1.15.2-dev.2";
