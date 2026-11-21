import { ChatMessage } from './Api';

export interface MessageRow extends ChatMessage { state: string; error: string; order: number; }

export class MessageSource implements IDataSource {
  private rows: MessageRow[] = [];
  private listeners: DataChangeListener[] = [];
  totalCount(): number { return this.rows.length; }
  getData(index: number): MessageRow { return this.rows[index]; }
  private key(row: MessageRow): string { return row.clientMessageId ? 'client:' + row.senderId + ':' + row.clientMessageId : 'server:' + row.id; }
  private changed(a: MessageRow,b: MessageRow): boolean {
    return a.id!==b.id || a.text!==b.text || a.state!==b.state || a.error!==b.error || a.createdAt!==b.createdAt || a.redacted!==b.redacted;
  }
  replace(rows: MessageRow[]): void {
    if (!this.rows.length || !rows.length) {
      if (!this.rows.length && !rows.length) return;
      this.rows = rows.slice();
      this.listeners.forEach((listener: DataChangeListener) => { listener.onDataReloaded(); });
      return;
    }
    const next = new Set<string>(rows.map((row: MessageRow) => this.key(row)));
    for (let i=this.rows.length-1;i>=0;i--) {
      if (!next.has(this.key(this.rows[i]))) {
        this.rows.splice(i,1);
        this.listeners.forEach((listener: DataChangeListener) => { listener.onDataDelete(i); });
      }
    }
    for (let i=0;i<rows.length;i++) {
      const row=rows[i], key=this.key(row);
      if (i<this.rows.length && this.key(this.rows[i])===key) {
        const changed=this.changed(this.rows[i],row); this.rows[i]=row;
        if (changed) this.listeners.forEach((listener: DataChangeListener) => { listener.onDataChange(i); });
      } else {
        const previous=this.rows.findIndex((item: MessageRow) => this.key(item)===key);
        if (previous>=0) {
          this.rows.splice(previous,1);
          this.listeners.forEach((listener: DataChangeListener) => { listener.onDataDelete(previous); });
        }
        this.rows.splice(i,0,row);
        this.listeners.forEach((listener: DataChangeListener) => { listener.onDataAdd(i); });
      }
    }
  }
  registerDataChangeListener(listener: DataChangeListener): void {
    if (this.listeners.indexOf(listener) < 0) this.listeners.push(listener);
  }
  unregisterDataChangeListener(listener: DataChangeListener): void {
    const index = this.listeners.indexOf(listener);
    if (index >= 0) this.listeners.splice(index, 1);
  }
}
