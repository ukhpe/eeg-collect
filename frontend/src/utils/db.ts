import Dexie, { Table } from 'dexie';

export interface EegData {
  id?: number;
  timestamp: number;
  payload: number[];
  // bc: Set for control messages ("Setup Finished", "Audio File Started", "Audio File Ended"),
  // bc: which are cached together with the EEG data. Not indexed, so no new db version is needed.
  control?: string;
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