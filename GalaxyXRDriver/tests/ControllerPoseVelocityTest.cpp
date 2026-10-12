#include "Driver/Hooking/ControllerPoseVelocity.h"
#include <array>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>

// Compile the real layout section of HandleDevicePoseUpdated, including its
// eligibility checks, with only external services/configuration stubbed.
struct ControllersConfig {
    double rotationOffsetDeg[3]{}, positionOffsetCm[3]{};
    double leftRotationOffsetDeg[3]{}, leftPositionOffsetCm[3]{};
    double rightRotationOffsetDeg[3]{}, rightPositionOffsetCm[3]{};
    bool mirrorOffsetsForRightHand = true;
    int spaceVelocityFixMode = 0;
};
struct GalaxyXRDeviceProvider {
    struct {
        bool forceTracking = false;
        struct { bool controllerBypass = false, gripConvention = false; } galaxyXr;
        struct { int velocityFixMode = 0; } streamFrame;
        ControllersConfig controllers;
    } driverConfig;
    std::atomic<bool> alignerOverrideActive{false};
    std::mutex poseLogLock;
    double alignerRotDeg[3]{}, alignerPosCm[3]{};
    bool alignerAppliedLogged = false, nativeHand = false, streamed = true;
    int deviceClass = vr::TrackedDeviceClass_Controller;
    std::unordered_map<uint32_t, int> openVRIDHand{{1, 0}, {2, 1}};
    bool IsNativeHand(uint32_t) const { return nativeHand; }
    bool IsStreamedController(uint32_t) const { return streamed; }
    int GetDeviceClass(uint32_t) const { return deviceClass; }
    bool HandleDevicePoseUpdated(uint32_t, vr::DriverPose_t&);
};
template<class... Args> void DriverLog(const char*, Args...) {}
#include "LayoutMethods.generated.h"

namespace {
using Q = vr::HmdQuaternion_t;
using V = std::array<double, 3>;
int checks = 0, failures = 0;
void Check(bool value, const char* label) {
    ++checks;
    if (!value) { ++failures; if (failures < 12) std::cerr << "FAIL: " << label << '\n'; }
}
Q Mul(Q a, Q b) { return {a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z,
    a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y, a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x,
    a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w}; }
Q Inv(Q q) { return {q.w,-q.x,-q.y,-q.z}; }
Q Unit(Q q) { double n=std::sqrt(q.w*q.w+q.x*q.x+q.y*q.y+q.z*q.z); return {q.w/n,q.x/n,q.y/n,q.z/n}; }
V Rot(Q q, V v) { auto r=Mul(Mul(q,{0,v[0],v[1],v[2]}),Inv(q)); return {r.x,r.y,r.z}; }
V Vec(const double* v) { return {v[0],v[1],v[2]}; }
V Add(V a,V b) { return {a[0]+b[0],a[1]+b[1],a[2]+b[2]}; }
V Sub(V a,V b) { return {a[0]-b[0],a[1]-b[1],a[2]-b[2]}; }
V Scale(V a,double s) { return {s*a[0],s*a[1],s*a[2]}; }
V Cross(V a,V b) { return {a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]}; }
double Norm(V v) { return std::sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]); }
Q Exp(V v) { double a=Norm(v),s=a?std::sin(a/2)/a:.5;return {std::cos(a/2),s*v[0],s*v[1],s*v[2]}; }
vr::DriverPose_t Pose() {
    vr::DriverPose_t p{};
    p.poseIsValid=p.deviceIsConnected=true;p.result=vr::TrackingResult_Running_OK;
    p.qRotation=Exp({.2,-.6,.1});p.qWorldFromDriverRotation=Exp({.1,.2,.3});
    p.qDriverFromHeadRotation=Exp({.5,.1,-.1});p.vecDriverFromHeadTranslation[2]=-.09;
    p.vecPosition[0]=.4;p.vecPosition[1]=1.1;p.vecPosition[2]=-.2;
    p.vecVelocity[0]=.2;p.vecVelocity[1]=-.7;p.vecVelocity[2]=.1;
    p.vecAngularVelocity[0]=2;p.vecAngularVelocity[1]=-.5;p.vecAngularVelocity[2]=.8;
    p.poseTimeOffset=.015;return p;
}
void OnlyDerivatives(const vr::DriverPose_t& before, vr::DriverPose_t after) {
    std::memcpy(after.vecVelocity,before.vecVelocity,sizeof(after.vecVelocity));
    std::memcpy(after.vecAngularVelocity,before.vecAngularVelocity,sizeof(after.vecAngularVelocity));
    Check(std::memcmp(&before,&after,sizeof(after))==0,"only v/w fields change");
}
// Independent physical oracle: evolve the source rigid body forward/backward
// in time, then place the captured final point and its head transform on it.
double Oracle(const vr::DriverPose_t& src,const vr::DriverPose_t& out) {
    const Q qs=Unit(src.qRotation),qo=Unit(out.qRotation),layout=Mul(Inv(qs),qo);
    const V offset=Rot(Inv(qs),Sub(Vec(out.vecPosition),Vec(src.vecPosition)));
    const V head=Vec(out.vecDriverFromHeadTranslation);
    const double eps=1e-5;
    V pp[2],axes[2][3];
    for(int side=0;side<2;++side) {
        const double dt=side?eps:-eps;const Q q=Mul(qs,Exp(Scale(Vec(src.vecAngularVelocity),dt)));
        const Q finalq=Mul(q,layout);
        pp[side]=Add(Add(Vec(src.vecPosition),Scale(Vec(src.vecVelocity),dt)),
            Add(Rot(q,offset),Rot(finalq,head)));
        for(int i=0;i<3;++i) { V basis{};basis[i]=1;axes[side][i]=Rot(finalq,basis); }
    }
    const V omega=Rot(qo,Vec(out.vecAngularVelocity));
    const V finalv=Add(Vec(out.vecVelocity),Cross(omega,Rot(qo,head)));
    double error=Norm(Sub(Scale(Sub(pp[1],pp[0]),.5/eps),finalv));
    for(int i=0;i<3;++i) {
        V basis{};basis[i]=1;
        const double e=Norm(Sub(Scale(Sub(axes[1][i],axes[0][i]),.5/eps),Cross(omega,Rot(qo,basis))));
        if(e>error)error=e;
    }
    return error;
}
void Tests() {
    for(int i=0;i<200;++i) {
        GalaxyXRDeviceProvider p;auto src=Pose();
        src.qRotation=Exp({.013*i,-.009*i,.007*i});
        src.vecAngularVelocity[0]=std::sin(i*.3)*4;
        src.vecAngularVelocity[1]=std::cos(i*.2)*3;
        p.driverConfig.galaxyXr.gripConvention=(i%2)==0;
        auto& c=p.driverConfig.controllers;
        c.positionOffsetCm[0]=.5;c.positionOffsetCm[1]=-1.5;c.positionOffsetCm[2]=.5;
        c.rotationOffsetDeg[0]=2;c.rotationOffsetDeg[1]=-5;c.rotationOffsetDeg[2]=-9;
        c.leftPositionOffsetCm[1]=.3;c.rightPositionOffsetCm[2]=-.8;
        c.leftRotationOffsetDeg[0]=7;c.rightRotationOffsetDeg[1]=11;
        if(i%3==0){p.alignerOverrideActive=true;p.alignerPosCm[2]=3;p.alignerRotDeg[1]=-13;}
        auto out=src;p.HandleDevicePoseUpdated(1+i%2,out);
#ifdef VENDOR_GALAXYXR
        Check(Oracle(src,out)<1e-7,"real layout pipeline agrees with rigid-body derivative");
#else
        Check(std::memcmp(src.vecVelocity,out.vecVelocity,sizeof(src.vecVelocity))==0
            && std::memcmp(src.vecAngularVelocity,out.vecAngularVelocity,sizeof(src.vecAngularVelocity))==0,"neutral derivatives unchanged");
#endif
    }
    auto src=Pose(),adjusted=src;adjusted.vecPosition[1]+=.05;
    adjusted.qRotation=Mul(src.qRotation,Exp({.3,.1,-.2}));
    auto corrected=adjusted;
    const bool applied=gxr::TransportControllerLayoutVelocity(src,corrected,true,0,false,0);
#ifdef VENDOR_GALAXYXR
    Check(applied && Oracle(src,corrected)<1e-7,"helper physical oracle");
#else
    Check(!applied && std::memcmp(&adjusted,&corrected,sizeof(adjusted))==0,"neutral helper no-op");
#endif
    OnlyDerivatives(adjusted,corrected);
    for(int mode=0;mode<20;++mode) {
        auto a=src,b=adjusted;bool physical=true,bypass=false;int fix=0,space=0;
        switch(mode){
        case 0:physical=false;break;case 1:bypass=true;break;case 2:fix=1;break;case 3:space=1;break;
        case 4:a.poseIsValid=false;break;case 5:a.deviceIsConnected=false;break;
        case 6:a.result=vr::TrackingResult_Running_OutOfRange;break;
        case 7:a.vecAcceleration[0]=1;break;case 8:b.vecAngularAcceleration[1]=1;break;
        case 9:a.qRotation={0,0,0,0};break;case 10:b.qRotation.w=2;break;
        case 11:a.vecVelocity[0]=b.vecVelocity[0]=std::numeric_limits<double>::infinity();break;
        case 12:b.vecVelocity[0]+=1;break;case 13:b.vecAngularVelocity[2]+=1;break;
        case 14:b.vecPosition[0]=std::numeric_limits<double>::quiet_NaN();break;
        case 15:a.vecAcceleration[0]=std::numeric_limits<double>::quiet_NaN();break;
        case 16:a.vecAngularVelocity[0]=b.vecAngularVelocity[0]=1e308;b.vecPosition[0]=1e308;break;
        case 17:b=a;break;case 18:b=a;b.qRotation={-a.qRotation.w,-a.qRotation.x,-a.qRotation.y,-a.qRotation.z};break;
        case 19:a.result=vr::TrackingResult_Fallback_RotationOnly;break;
        }
        auto before=b,original=a;
        Check(!gxr::TransportControllerLayoutVelocity(a,b,physical,fix,bypass,space),"invalid/unsupported source skips");
        Check(std::memcmp(&b,&before,sizeof(b))==0 && std::memcmp(&a,&original,sizeof(a))==0,"skip/source byte preservation");
    }
    for(int gate=0;gate<9;++gate) {
        GalaxyXRDeviceProvider p;auto input=src;uint32_t id=1;
        p.driverConfig.controllers.positionOffsetCm[0]=5;
        switch(gate){
        case 0:p.nativeHand=true;break;case 1:p.streamed=false;break;
        case 2:p.deviceClass=vr::TrackedDeviceClass_GenericTracker;break;
        case 3:id=vr::k_unTrackedDeviceIndex_Hmd;break;case 4:p.driverConfig.galaxyXr.controllerBypass=true;break;
        case 5:p.driverConfig.streamFrame.velocityFixMode=2;break;case 6:p.driverConfig.controllers.spaceVelocityFixMode=2;break;
        case 7:input.poseIsValid=false;p.driverConfig.forceTracking=true;break;
        case 8:input.result=vr::TrackingResult_Running_OutOfRange;p.driverConfig.forceTracking=true;break;
        }
        auto output=input;p.HandleDevicePoseUpdated(id,output);
        Check(std::memcmp(input.vecVelocity,output.vecVelocity,sizeof(input.vecVelocity))==0
            && std::memcmp(input.vecAngularVelocity,output.vecAngularVelocity,sizeof(input.vecAngularVelocity))==0,"production eligibility incl forceTracking preserves derivatives");
    }
}
#pragma pack(push,1)
struct Header {char magic[8];uint32_t version,size;uint64_t frequency,start,filetime,end,count,dropped,invalid;};
struct Record {uint64_t qpc,seq,parent,delivery;uint32_t kind,tid,device,size;unsigned char bytes[368];};
#pragma pack(pop)
void Replay(const char* directory,const char* output) {
    static_assert(sizeof(Header)==72 && sizeof(Record)==416 && sizeof(vr::DriverPose_t)==280);
    Header h{};std::ifstream hdr(std::string(directory)+"/header.bin",std::ios::binary);
    hdr.read(reinterpret_cast<char*>(&h),sizeof(h));
    if(!hdr || h.size!=sizeof(Record) || h.dropped || h.invalid)throw std::runtime_error("Capture header invalid");
    std::ifstream input(std::string(directory)+"/records.bin",std::ios::binary);std::ofstream out(output);
    if(!input || !out)throw std::runtime_error("Replay open failed");
    std::unordered_map<uint64_t,vr::DriverPose_t> sources;
    Record r{};uint64_t total=0,pairs=0;double maxError=0;
    out<<"delivery,device,vx,vy,vz,wx,wy,wz\n"<<std::setprecision(17);
    while(input.read(reinterpret_cast<char*>(&r),sizeof(r))) {
        ++total;if(r.device<1 || r.device>2 || (r.kind!=2 && r.kind!=3))continue;
        if(r.size!=sizeof(vr::DriverPose_t))throw std::runtime_error("Pose ABI mismatch");
        vr::DriverPose_t p{};std::memcpy(&p,r.bytes,sizeof(p));
        if(r.kind==2){if(!sources.emplace(r.delivery,p).second)throw std::runtime_error("Duplicate delivery");continue;}
        auto found=sources.find(r.delivery);if(found==sources.end())throw std::runtime_error("Missing input");
        auto before=p;const auto& src=found->second;
        const bool changed=gxr::TransportControllerLayoutVelocity(src,p,true,0,false,0);
#ifdef VENDOR_GALAXYXR
        Check(changed,"captured supported layout corrected");
        double e=Oracle(src,p);if(e>maxError)maxError=e;
        Check(e<1e-7,"capture independent rigid-body oracle");
#else
        Check(!changed,"neutral capture no-op");
#endif
        OnlyDerivatives(before,p);++pairs;sources.erase(found);
        out<<r.delivery<<','<<r.device;for(double x:p.vecVelocity)out<<','<<x;for(double x:p.vecAngularVelocity)out<<','<<x;out<<'\n';
    }
    if(input.gcount() || total!=h.count || !sources.empty() || !out || pairs==0)throw std::runtime_error("Incomplete replay");
    std::cout<<"Capture pairs="<<pairs<<" max rigid derivative error="<<std::setprecision(10)<<maxError<<'\n';
}
}
int main(int argc,char** argv) {
    try{Tests();if(argc==3)Replay(argv[1],argv[2]);else if(argc!=1)throw std::runtime_error("Expected [capture output]");
        std::cout<<"Layout velocity: "<<checks<<" checks, "<<failures<<" failures\n";return failures?1:0;
    }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
