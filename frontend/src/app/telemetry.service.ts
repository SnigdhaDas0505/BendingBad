import { Injectable, NgZone, inject } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import type { MaterialStressEvaluation, SpatialStrainNode } from './material-analysis';
import { createTelemetryWebSocketUrl, telemetryReconnectDelay } from './telemetry-connection';

export interface StressTelemetryFrame extends MaterialStressEvaluation {
  sequence: number;
  timestamp: number;
  source: 'simulated' | string;
  strain_input: { ex_micro: number; ey_micro: number; gamma_xy_micro: number };
  spatial_sensors?: SpatialStrainNode[];
}

export interface TelemetrySettings {
  youngsModulusGpa: number;
  poissonRatio: number;
  yieldStrengthMpa: number;
  warningFactorOfSafety: number;
  loadScale: number;
}

export type TelemetryConnectionState = 'disconnected' | 'connecting' | 'live' | 'reconnecting' | 'error';

@Injectable({ providedIn: 'root' })
export class TelemetryService {
  private readonly zone = inject(NgZone);
  private readonly frameSubject = new Subject<StressTelemetryFrame>();
  private readonly stateSubject = new BehaviorSubject<TelemetryConnectionState>('disconnected');
  private readonly errorSubject = new BehaviorSubject<string | null>(null);
  private socket: WebSocket | null = null;
  private connectionTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private settings: TelemetrySettings | null = null;
  private shouldConnect = false;
  private reconnectAttempt = 0;

  readonly frames$ = this.frameSubject.asObservable();
  readonly state$ = this.stateSubject.asObservable();
  readonly error$ = this.errorSubject.asObservable();

  connect(settings: TelemetrySettings): void {
    this.settings = settings;
    this.shouldConnect = true;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    this.closeSocket();
    this.errorSubject.next(null);
    this.openSocket();
  }

  disconnect(): void {
    this.shouldConnect = false;
    this.clearReconnectTimer();
    this.closeSocket();
    this.stateSubject.next('disconnected');
  }

  private openSocket(): void {
    if (!this.shouldConnect || !this.settings) return;
    this.stateSubject.next(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting');
    const url = createTelemetryWebSocketUrl(window.location, this.settings);

    try {
      const socket = new WebSocket(url);
      this.socket = socket;
      this.connectionTimeout = setTimeout(() => {
        if (this.socket !== socket || socket.readyState !== WebSocket.CONNECTING) return;
        this.errorSubject.next('Telemetry server did not respond. Retrying the connection.');
        socket.close();
      }, 5000);
      socket.onopen = () => this.zone.run(() => {
        if (this.socket !== socket) return;
        this.clearConnectionTimeout();
        this.reconnectAttempt = 0;
        this.stateSubject.next('live');
        this.errorSubject.next(null);
      });
      socket.onmessage = event => this.zone.run(() => {
        if (this.socket !== socket) return;
        try {
          const frame = JSON.parse(String(event.data)) as StressTelemetryFrame;
          if (this.stateSubject.value !== 'live') {
            this.reconnectAttempt = 0;
            this.stateSubject.next('live');
            this.errorSubject.next(null);
          }
          this.frameSubject.next(frame);
        } catch {
          this.errorSubject.next('The telemetry server sent an unreadable frame.');
        }
      });
      socket.onerror = () => this.zone.run(() => {
        if (this.socket === socket) {
          this.stateSubject.next('error');
          this.errorSubject.next('Telemetry connection failed. Retrying the stream.');
        }
      });
      socket.onclose = () => this.zone.run(() => {
        if (this.socket !== socket) return;
        this.clearConnectionTimeout();
        this.socket = null;
        if (this.shouldConnect) this.scheduleReconnect();
        else this.stateSubject.next('disconnected');
      });
    } catch (error: unknown) {
      this.stateSubject.next('error');
      this.errorSubject.next(error instanceof Error ? error.message : 'Could not open the telemetry connection.');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldConnect) return;
    this.reconnectAttempt += 1;
    this.stateSubject.next('reconnecting');
    const delay = telemetryReconnectDelay(this.reconnectAttempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private closeSocket(): void {
    this.clearConnectionTimeout();
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.onopen = null;
    socket.close();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearConnectionTimeout(): void {
    if (this.connectionTimeout === null) return;
    clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
  }
}
