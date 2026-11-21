export class ListSource<T> implements IDataSource {
  private rows: T[] = [];
  private listeners: DataChangeListener[] = [];
  private key: (row:T) => string;
  constructor(key:(row:T) => string) {this.key=key;}
  totalCount(): number { return this.rows.length; }
  getData(index: number): T { return this.rows[index]; }
  replace(rows: T[]): void {
    const next=new Set<string>(rows.map((row:T) => this.key(row)));
    for (let i=this.rows.length-1;i>=0;i--) {
      if (!next.has(this.key(this.rows[i]))) {
        this.rows.splice(i,1);
        this.listeners.forEach((listener:DataChangeListener) => {listener.onDataDelete(i);});
      }
    }
    for (let i=0;i<rows.length;i++) {
      const row=rows[i],key=this.key(row);
      if (i<this.rows.length && this.key(this.rows[i])===key) {
        const changed=this.rows[i]!==row;this.rows[i]=row;
        if (changed) this.listeners.forEach((listener:DataChangeListener) => {listener.onDataChange(i);});
      } else {
        const previous=this.rows.findIndex((item:T) => this.key(item)===key);
        if (previous>=0) {this.rows.splice(previous,1);this.listeners.forEach((listener:DataChangeListener) => {listener.onDataDelete(previous);});}
        this.rows.splice(i,0,row);this.listeners.forEach((listener:DataChangeListener) => {listener.onDataAdd(i);});
      }
    }
  }
  registerDataChangeListener(listener: DataChangeListener): void { if (this.listeners.indexOf(listener)<0) this.listeners.push(listener); }
  unregisterDataChangeListener(listener: DataChangeListener): void {
    const index=this.listeners.indexOf(listener); if (index>=0) this.listeners.splice(index,1);
  }
}
