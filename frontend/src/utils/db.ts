import Dexie, { Table } from 'dexie';

export interface EegData {
  id?: number;
  sessionId: string;
  timestamp: number;
  participantId: string;
  payload: number[];
}

class EegDatabase extends Dexie {
    eegData!: Table<EegData>;

    constructor() {
        super('EegDatabase');
        this.version(1).stores({
            eegData: '++id, sessionId, timestamp, participantId',
        });
    }
}

export const db = new EegDatabase();