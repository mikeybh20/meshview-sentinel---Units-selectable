import React from 'react';
import { Thermometer, Droplets, Gauge, Wind, Cpu, Link2, Activity, Zap } from 'lucide-react';
import { Node, UnitSystem } from '../types';
import { cn } from '../lib/utils';
import { motion } from 'motion/react';

interface SensorWidgetProps {
  node: Node | null;
  allNodes: Node[];
  unitSystem: UnitSystem;
}

export function SensorWidget({ node, allNodes, unitSystem }: SensorWidgetProps) {
  const convertTemp = (c?: number) => {
    if (c === undefined) return undefined;
    return unitSystem === 'METRIC' ? c : (c * 9/5 + 32);
  };

  const convertPressure = (hpa?: number) => {
    if (hpa === undefined) return undefined;
    return unitSystem === 'METRIC' ? hpa : (hpa * 0.02953);
  };

  const tempUnit = unitSystem === 'METRIC' ? '°C' : '°F';
  const pressUnit = unitSystem === 'METRIC' ? 'hPa' : 'inHg';

  // If no node selected, show a mesh-wide sensor overview
  if (!node) {
    const nodesWithSensors = allNodes.filter(n => n.sensors);
    
    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center gap-2 mb-4">
          <Activity size={18} className="text-brand-accent" />
          <h3 className="text-sm font-bold uppercase tracking-widest">Mesh Sensor Network</h3>
        </div>
        
        <div className="flex-1 overflow-y-auto space-y-3 pr-1 custom-scrollbar">
          {nodesWithSensors.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center opacity-30 text-center p-4">
              <Wind size={32} className="mb-2" />
              <p className="text-[10px] uppercase tracking-tighter">No active sensor telemetry detected in mesh</p>
            </div>
          ) : (
            nodesWithSensors.map(n => (
              <div key={n.id} className="bg-brand-line/10 border border-brand-line/30 rounded-lg p-3 hover:border-brand-accent/30 transition-colors">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-[10px] font-bold text-brand-muted uppercase tracking-wider">{n.name}</span>
                  {n.sensors?.bridge?.connected && (
                    <div className="flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-brand-accent animate-pulse" />
                      <span className="text-[8px] text-brand-accent font-bold uppercase">Pi Bridge Active</span>
                    </div>
                  )}
                </div>
                
                <div className="grid grid-cols-3 gap-2">
                  {n.sensors?.temperature !== undefined && (
                    <div className="flex flex-col">
                      <span className="text-[8px] text-brand-muted uppercase">Temp</span>
                      <span className="text-xs font-mono">{convertTemp(n.sensors.temperature)?.toFixed(1)}{tempUnit}</span>
                    </div>
                  )}
                  {n.sensors?.humidity !== undefined && (
                    <div className="flex flex-col">
                      <span className="text-[8px] text-brand-muted uppercase">Hum</span>
                      <span className="text-xs font-mono">{n.sensors.humidity.toFixed(0)}%</span>
                    </div>
                  )}
                  {n.sensors?.iaq !== undefined && (
                    <div className="flex flex-col">
                      <span className="text-[8px] text-brand-muted uppercase">IAQ</span>
                      <span className={cn(
                        "text-xs font-mono",
                        n.sensors.iaq < 50 ? "text-brand-accent" : "text-yellow-500"
                      )}>{n.sensors.iaq}</span>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  const sensors = node.sensors;

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Activity size={18} className="text-brand-accent" />
          <h3 className="text-sm font-bold uppercase tracking-widest">Node Sensor Array</h3>
        </div>
        {sensors?.bridge?.connected && (
          <div className="px-2 py-0.5 bg-brand-accent/10 border border-brand-accent/30 rounded text-[9px] text-brand-accent font-bold uppercase">
            {sensors.bridge.type.replace('_', ' ')} Link
          </div>
        )}
      </div>

      {!sensors ? (
        <div className="flex-1 flex flex-col items-center justify-center opacity-30 text-center p-6 bg-brand-line/5 rounded-xl border border-dashed border-brand-line">
          <Zap size={32} className="mb-2" />
          <p className="text-xs font-medium">No peripherals connected to {node.shortName}</p>
          <p className="text-[9px] uppercase mt-1">Connect a Raspberry Pi or BME680 sensor to view data</p>
        </div>
      ) : (
        <div className="flex-1 grid grid-cols-2 gap-3">
          {/* Main Sensors */}
          <div className="bg-brand-line/10 border border-brand-line/30 rounded-xl p-3 flex flex-col justify-center items-center gap-1 group hover:border-brand-accent/50 transition-all">
            <Thermometer size={20} className="text-brand-muted group-hover:text-brand-accent transition-colors" />
            <span className="text-[9px] text-brand-muted uppercase font-bold tracking-widest">Temperature</span>
            <span className="text-2xl font-mono tracking-tighter">
              {convertTemp(sensors.temperature)?.toFixed(1)}<span className="text-xs text-brand-muted ml-0.5">{tempUnit}</span>
            </span>
          </div>

          <div className="bg-brand-line/10 border border-brand-line/30 rounded-xl p-3 flex flex-col justify-center items-center gap-1 group hover:border-blue-500/50 transition-all">
            <Droplets size={20} className="text-brand-muted group-hover:text-blue-500 transition-colors" />
            <span className="text-[9px] text-brand-muted uppercase font-bold tracking-widest">Humidity</span>
            <span className="text-2xl font-mono tracking-tighter">
              {sensors.humidity?.toFixed(0)}<span className="text-xs text-brand-muted ml-0.5">%</span>
            </span>
          </div>

          <div className="bg-brand-line/10 border border-brand-line/30 rounded-xl p-3 flex flex-col justify-center items-center gap-1 group hover:border-purple-500/50 transition-all">
            <Gauge size={20} className="text-brand-muted group-hover:text-purple-500 transition-colors" />
            <span className="text-[9px] text-brand-muted uppercase font-bold tracking-widest">Pressure</span>
            <span className="text-lg font-mono tracking-tighter">
              {convertPressure(sensors.pressure)?.toFixed(unitSystem === 'METRIC' ? 1 : 2)}<span className="text-[9px] text-brand-muted ml-0.5">{pressUnit}</span>
            </span>
          </div>

          <div className="bg-brand-line/10 border border-brand-line/30 rounded-xl p-3 flex flex-col justify-center items-center gap-1 group hover:border-brand-accent/50 transition-all">
            <Wind size={20} className="text-brand-muted group-hover:text-brand-accent transition-colors" />
            <span className="text-[9px] text-brand-muted uppercase font-bold tracking-widest">Air Quality</span>
            <span className={cn(
              "text-2xl font-mono tracking-tighter",
              (sensors.iaq || 0) < 50 ? "text-brand-accent" : "text-yellow-500"
            )}>
              {sensors.iaq}
            </span>
          </div>

          {/* Bridge Stats if Pi is connected */}
          {sensors.bridge && (
            <div className="col-span-2 bg-brand-bg border border-brand-accent/20 rounded-xl p-3 mt-1 shadow-inner relative overflow-hidden">
              <div className="absolute top-0 right-0 p-2 opacity-5">
                <Cpu size={48} />
              </div>
              
              <div className="flex items-center gap-2 mb-3">
                <Link2 size={14} className="text-brand-accent" />
                <h4 className="text-[10px] font-bold uppercase tracking-widest text-brand-accent">Raspberry Pi Peripheral Link</h4>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-0.5">
                  <p className="text-[8px] text-brand-muted uppercase">CPU Temp</p>
                  <p className="text-xs font-mono">{convertTemp(sensors.bridge.cpuTemp)?.toFixed(1)}{tempUnit}</p>
                </div>
                <div className="space-y-0.5">
                  <p className="text-[8px] text-brand-muted uppercase">RAM Usage</p>
                  <p className="text-xs font-mono">{sensors.bridge.ramUsage?.toFixed(1)}%</p>
                </div>
                <div className="space-y-0.5">
                  <p className="text-[8px] text-brand-muted uppercase">System Uptime</p>
                  <p className="text-[10px] font-mono truncate">
                    {Math.floor(sensors.bridge.uptime / 3600)}h {Math.floor((sensors.bridge.uptime % 3600) / 60)}m
                  </p>
                </div>
              </div>

              <div className="mt-3 pt-3 border-t border-brand-line/30 flex justify-between items-center">
                <div className="flex items-center gap-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-brand-accent animate-pulse" />
                  <span className="text-[8px] font-bold uppercase text-brand-muted">Serial Interface active</span>
                </div>
                <button className="text-[8px] font-bold uppercase tracking-widest bg-brand-line px-2 py-1 rounded hover:bg-brand-accent hover:text-black transition-all">
                  Open Pi Console
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
