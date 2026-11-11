import Dexie, { Table } from 'dexie';

export interface EegData {
  id?: number;
  timestamp: number;
  payload: number[];
}

class EegDatabase extends Dexie {
    eegData!: Table<EegData>;

    constructor() {
        super('EegDatabase');
        this.version(1).stores({
            eegData: '++id, timestamp',
        });
    }
}

export const db = new EegDatabase();