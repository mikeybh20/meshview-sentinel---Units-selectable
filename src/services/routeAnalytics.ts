import { Node, RouteRecord, UptimeRecord } from '../types';

export interface RelayStats {
  nodeId: string;
  nodeName: string;
  relayCount: number;        // how many times this node relayed for this pair
  totalRoutes: number;       // total routes for this pair
  relayPercent: number;      // relayCount / totalRoutes * 100
  avgDeliveryMs: number;     // avg delivery time when this node relays
  successRate: number;       // % of successful deliveries via this relay
}

export interface PairAnalysis {
  from: string;
  to: string;
  fromName: string;
  toName: string;
  totalMessages: number;
  successRate: number;
  avgDeliveryMs: number;
  relays: RelayStats[];      // sorted by relayPercent desc
  bestRoute: string[];       // most common hop sequence
}

export interface NodeUptimeStats {
  nodeId: string;
  nodeName: string;
  online: boolean;
  totalUptimeMs: number;
  totalDowntimeMs: number;
  uptimePercent: number;
  sessions: { onlineAt: number; offlineAt: number | null; durationMs: number }[];
  avgSessionMs: number;
  peakHours: number[];       // hours of day (0-23) when node is most often online
}

export interface SendWindow {
  hour: number;
  score: number;             // 0-100, higher = more relays online
  onlineRelays: string[];    // relay node names expected online
  totalRelays: number;       // total needed relays
}

export class RouteAnalyticsService {
  /**
   * Analyze all routes between every communicating pair
   */
  static analyzePairs(routes: RouteRecord[], nodes: Node[]): PairAnalysis[] {
    const pairMap = new Map<string, RouteRecord[]>();

    for (const r of routes) {
      const key = `${r.from}→${r.to}`;
      if (!pairMap.has(key)) pairMap.set(key, []);
      pairMap.get(key)!.push(r);
    }

    const results: PairAnalysis[] = [];

    for (const [key, records] of pairMap) {
      const [fromId, toId] = key.split('→');
      const fromNode = nodes.find(n => n.id === fromId);
      const toNode = nodes.find(n => n.id === toId);

      const totalMessages = records.length;
      const successCount = records.filter(r => r.success).length;
      const successRate = totalMessages > 0 ? (successCount / totalMessages) * 100 : 0;
      const avgDeliveryMs = records.reduce((a, r) => a + r.deliveryMs, 0) / totalMessages;

      // Relay frequency analysis
      const relayCountMap = new Map<string, { count: number; deliverySum: number; successCount: number }>();
      for (const r of records) {
        for (const hop of r.hops) {
          if (!relayCountMap.has(hop)) relayCountMap.set(hop, { count: 0, deliverySum: 0, successCount: 0 });
          const entry = relayCountMap.get(hop)!;
          entry.count++;
          entry.deliverySum += r.deliveryMs;
          if (r.success) entry.successCount++;
        }
      }

      const relays: RelayStats[] = Array.from(relayCountMap.entries())
        .map(([nodeId, stats]) => ({
          nodeId,
          nodeName: nodes.find(n => n.id === nodeId)?.name || nodeId,
          relayCount: stats.count,
          totalRoutes: totalMessages,
          relayPercent: (stats.count / totalMessages) * 100,
          avgDeliveryMs: stats.deliverySum / stats.count,
          successRate: (stats.successCount / stats.count) * 100,
        }))
        .sort((a, b) => b.relayPercent - a.relayPercent);

      // Most common route
      const routeFreq = new Map<string, number>();
      for (const r of records) {
        const routeKey = r.hops.join(',');
        routeFreq.set(routeKey, (routeFreq.get(routeKey) || 0) + 1);
      }
      let bestRouteKey = '';
      let bestRouteCount = 0;
      for (const [rk, count] of routeFreq) {
        if (count > bestRouteCount) { bestRouteKey = rk; bestRouteCount = count; }
      }

      results.push({
        from: fromId,
        to: toId,
        fromName: fromNode?.name || fromId,
        toName: toNode?.name || toId,
        totalMessages,
        successRate,
        avgDeliveryMs,
        relays,
        bestRoute: bestRouteKey ? bestRouteKey.split(',') : [],
      });
    }

    return results.sort((a, b) => b.totalMessages - a.totalMessages);
  }

  /**
   * Compute uptime statistics per node
   */
  static analyzeUptime(uptimeRecords: UptimeRecord[], nodes: Node[]): NodeUptimeStats[] {
    const now = Date.now();
    const nodeMap = new Map<string, UptimeRecord[]>();

    for (const r of uptimeRecords) {
      if (!nodeMap.has(r.nodeId)) nodeMap.set(r.nodeId, []);
      nodeMap.get(r.nodeId)!.push(r);
    }

    return nodes.map(node => {
      const records = nodeMap.get(node.id) || [];
      const sessions = records.map(r => ({
        onlineAt: r.onlineAt,
        offlineAt: r.offlineAt,
        durationMs: (r.offlineAt || now) - r.onlineAt,
      }));

      const totalUptimeMs = sessions.reduce((a, s) => a + s.durationMs, 0);
      const earliest = records.length > 0 ? Math.min(...records.map(r => r.onlineAt)) : now;
      const totalWindowMs = now - earliest || 1;
      const totalDowntimeMs = Math.max(0, totalWindowMs - totalUptimeMs);
      const uptimePercent = Math.min(100, (totalUptimeMs / totalWindowMs) * 100);
      const avgSessionMs = sessions.length > 0 ? totalUptimeMs / sessions.length : 0;

      // Peak hours: count which hours of day each session covers
      const hourCounts = new Array(24).fill(0);
      for (const s of sessions) {
        const startHour = new Date(s.onlineAt).getHours();
        const endHour = new Date(s.offlineAt || now).getHours();
        if (startHour <= endHour) {
          for (let h = startHour; h <= endHour; h++) hourCounts[h]++;
        } else {
          for (let h = startHour; h < 24; h++) hourCounts[h]++;
          for (let h = 0; h <= endHour; h++) hourCounts[h]++;
        }
      }
      const maxHourCount = Math.max(...hourCounts, 1);
      const peakHours = hourCounts
        .map((c, h) => ({ h, c }))
        .filter(x => x.c >= maxHourCount * 0.7)
        .map(x => x.h);

      return {
        nodeId: node.id,
        nodeName: node.name,
        online: node.online,
        totalUptimeMs,
        totalDowntimeMs,
        uptimePercent,
        sessions,
        avgSessionMs,
        peakHours,
      };
    });
  }

  /**
   * For a given source→destination pair, compute the best send windows
   * by cross-referencing relay uptime patterns
   */
  static computeSendWindows(
    pairAnalysis: PairAnalysis,
    uptimeStats: NodeUptimeStats[]
  ): SendWindow[] {
    // Get the critical relay nodes (used in >20% of routes)
    const criticalRelays = pairAnalysis.relays.filter(r => r.relayPercent > 20);
    if (criticalRelays.length === 0) {
      // No relay dependency — any hour is fine
      return Array.from({ length: 24 }, (_, h) => ({
        hour: h,
        score: 100,
        onlineRelays: [],
        totalRelays: 0,
      }));
    }

    const windows: SendWindow[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const onlineRelays: string[] = [];
      for (const relay of criticalRelays) {
        const stats = uptimeStats.find(u => u.nodeId === relay.nodeId);
        if (stats && stats.peakHours.includes(hour)) {
          onlineRelays.push(relay.nodeName);
        }
      }
      const score = criticalRelays.length > 0
        ? Math.round((onlineRelays.length / criticalRelays.length) * 100)
        : 100;

      windows.push({ hour, score, onlineRelays, totalRelays: criticalRelays.length });
    }

    return windows;
  }
}
