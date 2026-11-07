#include "Config.h"
Config driverConfig = {};
Config driverConfigOld = {};
Config defaultDriverConfig = {};
std::mutex driverConfigLock;
std::string driverVersion = "2.1.2-dev.1";
