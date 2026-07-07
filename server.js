const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const configPath = path.join(__dirname, 'server-config.json');
let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const PORT = config.port || 3456;
const APP_DATA = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
const DATA_DIR = path.join(APP_DATA, 'KasirPro');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'kasirpro.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// Generate cabang ID once
if (!config.cabangId || config.cabangId === 'AUTO') {
    config.cabangId = crypto.randomBytes(4).toString('hex').toUpperCase();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
}

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

let db;
let SQL_CONSTRUCTOR;

function loadDatabase(SQL) {
    try {
        if (fs.existsSync(DB_PATH)) {
            const buffer = fs.readFileSync(DB_PATH);
            return new SQL.Database(buffer);
        }
    } catch (e) { console.error('Load db error:', e.message); }
    return new SQL.Database();
}

var backupCounter = 0;
function saveDatabase() {
    try {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(DB_PATH, buffer);
        backupCounter++;
        if (backupCounter % 10 === 0) {
            try {
                const ts = new Date().toISOString().slice(0,19).replace(/[:-]/g,'');
                fs.writeFileSync(path.join(BACKUP_DIR, 'backup-' + ts + '.db'), buffer);
                const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('backup-')).sort().reverse();
                while (files.length > 20) {
                    fs.unlinkSync(path.join(BACKUP_DIR, files.pop()));
                }
            } catch (e) { console.error('Backup error:', e.message); }
        }
    } catch (e) { console.error('Save db error:', e.message); }
}

function q(sql, params) {
    try {
        const stmt = db.prepare(sql);
        if (params) stmt.bind(params);
        const results = [];
        while (stmt.step()) results.push(stmt.getAsObject());
        stmt.free();
        return results;
    } catch (e) { throw e; }
}

function run(sql, params) {
    try {
        db.run(sql, params);
        const changes = db.getRowsModified();
        return changes;
    } catch (e) { throw e; }
}

function get(sql, params) {
    const rows = q(sql, params);
    return rows.length ? rows[0] : null;
}

function initDb(SQL) {
    db = loadDatabase(SQL);
    db.run('CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT, name TEXT, description TEXT, price REAL DEFAULT 0, stock REAL DEFAULT 0, category TEXT, cost_price REAL DEFAULT 0, unit TEXT, extra_data TEXT DEFAULT "{}")');
    db.run('CREATE TABLE IF NOT EXISTS penjualan (id INTEGER PRIMARY KEY AUTOINCREMENT, no_faktur TEXT UNIQUE, tanggal TEXT, jam TEXT, keterangan TEXT, pelanggan TEXT, pelanggan_id INTEGER, jumlah REAL, subtotal REAL, bayar REAL, piutang TEXT, kas TEXT, jth_tempo TEXT, operator TEXT, jasa_kirim TEXT, biaya_kirim REAL, items_data TEXT, kode_cabang TEXT DEFAULT "")');
    db.run('CREATE TABLE IF NOT EXISTS pembelian (id INTEGER PRIMARY KEY AUTOINCREMENT, no_faktur TEXT UNIQUE, tanggal TEXT, supplier TEXT, supplier_id INTEGER, jumlah REAL, kas TEXT, keterangan TEXT, metode TEXT, operator TEXT, kode_cabang TEXT DEFAULT "")');
    // Migration: add kode_cabang if missing on existing tables
    try { db.run('ALTER TABLE penjualan ADD COLUMN kode_cabang TEXT DEFAULT ""'); } catch(e) {}
    try { db.run('ALTER TABLE pembelian ADD COLUMN kode_cabang TEXT DEFAULT ""'); } catch(e) {}
    db.run('CREATE TABLE IF NOT EXISTS pelanggan (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, name TEXT, phone TEXT, address TEXT, email TEXT, credit_limit REAL DEFAULT 0, extra_data TEXT DEFAULT "{}")');
    db.run('CREATE TABLE IF NOT EXISTS suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, name TEXT, address TEXT, email TEXT, phone TEXT, balance REAL DEFAULT 0, credit_limit REAL DEFAULT 0, contact_person TEXT, description TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS kas (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, name TEXT, balance REAL DEFAULT 0, type TEXT, notes TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS biaya (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, name TEXT, category TEXT, description TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, role TEXT, extra_data TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS hutang (id INTEGER PRIMARY KEY AUTOINCREMENT, no_faktur TEXT, tanggal TEXT, supplier TEXT, supplier_id INTEGER, jumlah REAL, kas TEXT, keterangan TEXT, operator TEXT, kode_cabang TEXT, lunas INTEGER DEFAULT 0)');
    db.run('CREATE TABLE IF NOT EXISTS piutang (id INTEGER PRIMARY KEY AUTOINCREMENT, no_faktur TEXT, tanggal TEXT, pelanggan TEXT, pelanggan_id INTEGER, jumlah REAL, kas TEXT, keterangan TEXT, operator TEXT, kode_cabang TEXT, lunas INTEGER DEFAULT 0)');
    db.run('CREATE TABLE IF NOT EXISTS rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, number TEXT, name TEXT, status TEXT DEFAULT "available", price REAL DEFAULT 0, keterangan TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS pemasukan (id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT, keterangan TEXT, jumlah REAL, kas TEXT, catatan TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS pengeluaran (id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT, keterangan TEXT, jumlah REAL, kas TEXT, catatan TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS mutasi_kas (id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT, dari TEXT, ke TEXT, jumlah REAL, keterangan TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS mutasi_barang (id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT, barang TEXT, tipe TEXT, jumlah REAL, keterangan TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS stok_opname (id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT, selesai INTEGER DEFAULT 0, items_data TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT)');
    saveDatabase();
    console.log('SQLite database ready:', DB_PATH);
}

function rowToProduct(row) {
    const extra = row.extra_data ? JSON.parse(row.extra_data) : {};
    return Object.assign({ id: row.id, kode: row.sku, nama: row.name, kategori: row.category || '', satuan: row.unit || 'PCS', stok: row.stock || 0, hbeli: row.cost_price || 0, hjual: row.price || 0, deskripsi: row.description || '', catatan: row.description || '', merk: '', minToko: 5, minGudang: 20, gudang: 'GUDANG A', rak: '', pajak: '0', diskon: 0, uwEnabled: false, ukuranWarna: [] }, extra);
}

// ---- API Routes ----

app.get('/api/sync/all', (req, res) => {
    try {
        res.json({
            inventory: q('SELECT * FROM products').map(rowToProduct),
            penjualan: q('SELECT * FROM penjualan ORDER BY id DESC').map(r => ({ id: r.id, noFaktur: r.no_faktur, tanggal: r.tanggal, jam: r.jam, ket: r.keterangan, pelanggan: r.pelanggan, pelangganId: r.pelanggan_id, jumlah: r.jumlah, subtotal: r.subtotal, bayar: r.bayar, piutang: r.piutang, kas: r.kas, jthTempo: r.jth_tempo, operator: r.operator, jasaKirim: r.jasa_kirim, biayaKirim: r.biaya_kirim, kodeCabang: r.kode_cabang, items: r.items_data ? JSON.parse(r.items_data) : [] })),
            pembelian: q('SELECT * FROM pembelian ORDER BY id DESC'),
            pelanggan: q('SELECT * FROM pelanggan').map(r => ({ id: r.id, kode: r.code || String(r.id).padStart(8,'0'), nama: r.name, telp: r.phone||'', alamat: r.address||'', email: r.email||'', batasPiutang: r.credit_limit||0, kartuMember:'', group:'Umum', saldoPiutang:0, saldoTabungan:0, jumlahPoint:0, foto:'', tanggalDaftar:'' })),
            supplier: q('SELECT * FROM suppliers').map(r => ({ id: String(r.id), kode: r.code || String(r.id).padStart(8,'0'), nama: r.name, alamat: r.address||'', kota: '', telp: r.phone||'', npwp: '', catatan: '', saldoHutang: r.balance||0 })),
            kas: q('SELECT * FROM kas').map(r => ({ id: r.id, kode: r.code||'', nama: r.name, saldo: r.balance||0, tipe: r.type||'Tunai', keterangan: r.notes||'' })),
            biaya: q('SELECT * FROM biaya').map(r => ({ id: r.id, kode: r.code||'', nama: r.name, kategori: r.category||'Operasional', keterangan: r.description||'' })),
            stokopname: q('SELECT * FROM stok_opname ORDER BY id DESC').map(r => ({ id: r.id, tanggal: r.tanggal, selesai: r.selesai==1, items: r.items_data?JSON.parse(r.items_data):[] }))
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/products', (req, res) => {
    try {
        const p = req.body;
        const kategori = p.kategori || p.category || '';
        const extra = {};
        if (p.stockCabang) extra.stockCabang = p.stockCabang;
        run('INSERT INTO products (sku,name,description,price,stock,category,cost_price,unit,extra_data) VALUES (?,?,?,?,?,?,?,?,?)', [p.sku, p.name, p.description||'', p.price||0, p.stock||0, kategori, p.cost_price||0, p.unit||'PCS', JSON.stringify(extra)]);
        saveDatabase();
        const row = get('SELECT * FROM products ORDER BY id DESC LIMIT 1');
        res.json({ product: row });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/products/:id', (req, res) => {
    try {
        const p = req.body;
        const kategori = p.kategori || p.category || '';
        const extra = {};
        if (p.stockCabang) extra.stockCabang = p.stockCabang;
        run('UPDATE products SET sku=?,name=?,description=?,price=?,stock=?,category=?,cost_price=?,unit=?,extra_data=? WHERE id=?', [p.sku, p.name, p.description||'', p.price||0, p.stock||0, kategori, p.cost_price||0, p.unit||'PCS', JSON.stringify(extra), req.params.id]);
        saveDatabase();
        const row = get('SELECT * FROM products WHERE id=?', [req.params.id]);
        res.json({ product: row });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/products/:id', (req, res) => {
    try { run('DELETE FROM products WHERE id=?', [req.params.id]); saveDatabase(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

function crudTable(name, fields, idCol) {
    const ph = fields.map(() => '?').join(',');
    const cols = fields.join(',');
    const sets = fields.map(f => f + '=?').join(',');
    app.post('/api/' + name, (req, res) => {
        try {
            const vals = fields.map(f => req.body[f] || '');
            run('INSERT INTO ' + name + ' (' + cols + ') VALUES (' + ph + ')', vals);
            saveDatabase();
            res.json({ id: get('SELECT MAX(id) as id FROM ' + name).id });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.put('/api/' + name + '/:id', (req, res) => {
        try {
            const vals = fields.map(f => req.body[f] || '');
            vals.push(req.params.id);
            run('UPDATE ' + name + ' SET ' + sets + ' WHERE ' + (idCol||'id') + '=?', vals);
            saveDatabase();
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.delete('/api/' + name + '/:id', (req, res) => {
        try { run('DELETE FROM ' + name + ' WHERE ' + (idCol||'id') + '=?', [req.params.id]); saveDatabase(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
    });
}

crudTable('suppliers', ['code','name','address','email','phone','balance','credit_limit','contact_person','description']);
crudTable('pelanggan', ['code','name','phone','address','email','credit_limit','extra_data']);
crudTable('kas', ['code','name','balance','type','notes']);
crudTable('biaya', ['code','name','category','description']);

app.post('/api/sync/transactions', (req, res) => {
    try {
        const d = req.body;
        const cabangId = d.cabangId || config.cabangId;
        if (d.penjualan) {
            for (let t of d.penjualan) {
                const ex = get('SELECT id FROM penjualan WHERE no_faktur=? AND kode_cabang=?', [t.noFaktur, cabangId]);
                const itemsStr = JSON.stringify(t.items || []);
                if (ex) {
                    run('UPDATE penjualan SET tanggal=?,jam=?,keterangan=?,pelanggan=?,pelanggan_id=?,jumlah=?,subtotal=?,bayar=?,piutang=?,kas=?,jth_tempo=?,operator=?,jasa_kirim=?,biaya_kirim=?,items_data=?,kode_cabang=? WHERE id=?', [t.tanggal, t.jam, t.ket||'', t.pelanggan||'Umum', t.pelangganId||null, t.jumlah||0, t.subtotal||0, t.bayar||0, t.piutang||'', t.kas||'', t.jthTempo||'', t.operator||'Admin', t.jasaKirim||'', t.biayaKirim||0, itemsStr, cabangId, ex.id]);
                } else {
                    run('INSERT INTO penjualan (no_faktur,tanggal,jam,keterangan,pelanggan,pelanggan_id,jumlah,subtotal,bayar,piutang,kas,jth_tempo,operator,jasa_kirim,biaya_kirim,items_data,kode_cabang) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [t.noFaktur, t.tanggal, t.jam, t.ket||'', t.pelanggan||'Umum', t.pelangganId||null, t.jumlah||0, t.subtotal||0, t.bayar||0, t.piutang||'', t.kas||'', t.jthTempo||'', t.operator||'Admin', t.jasaKirim||'', t.biayaKirim||0, itemsStr, cabangId]);
                }
            }
        }
        if (d.pembelian) {
            for (let t of d.pembelian) {
                const ex = get('SELECT id FROM pembelian WHERE no_faktur=? AND kode_cabang=?', [t.noFaktur, cabangId]);
                if (ex) {
                    run('UPDATE pembelian SET tanggal=?,supplier=?,supplier_id=?,jumlah=?,kas=?,keterangan=?,metode=?,operator=?,kode_cabang=? WHERE id=?', [t.tanggal, t.supplier, t.supplierId||null, t.jumlah||0, t.kas||'', t.keterangan||'', t.metode||'Tunai', t.operator||'Admin', cabangId, ex.id]);
                } else {
                    run('INSERT INTO pembelian (no_faktur,tanggal,supplier,supplier_id,jumlah,kas,keterangan,metode,operator,kode_cabang) VALUES (?,?,?,?,?,?,?,?,?,?)', [t.noFaktur, t.tanggal, t.supplier, t.supplierId||null, t.jumlah||0, t.kas||'', t.keterangan||'', t.metode||'Tunai', t.operator||'Admin', cabangId]);
                }
            }
        }
        saveDatabase();
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sync/migrate', (req, res) => {
    try {
        const d = req.body;
        const tx = () => {
            if (d.inventory) for (let item of d.inventory) {
                const ex = get('SELECT id FROM products WHERE sku=?', [item.kode]);
                if (!ex) run('INSERT INTO products (sku,name,description,price,stock,category,cost_price,unit,extra_data) VALUES (?,?,?,?,?,?,?,?,?)', [item.kode, item.nama, item.deskripsi||'', item.hjual||0, item.stok||0, item.kategori||'', item.hbeli||0, item.satuan||'PCS', '{}']);
            }
            if (d.pelanggan) for (let p of d.pelanggan) {
                const ex = get('SELECT id FROM pelanggan WHERE code=?', [p.kode||String(p.id)]);
                if (!ex) run('INSERT INTO pelanggan (code,name,phone,address,email) VALUES (?,?,?,?,?)', [p.kode||String(p.id), p.nama, p.telp||'', p.alamat||'', p.email||'']);
            }
            if (d.supplier) for (let s of d.supplier) {
                const ex = get('SELECT id FROM suppliers WHERE code=?', [s.kode||String(s.id)]);
                if (!ex) run('INSERT INTO suppliers (code,name,address,phone) VALUES (?,?,?,?)', [s.kode||String(s.id), s.nama, s.alamat||'', s.telp||'']);
            }
            if (d.kas) for (let k of d.kas) {
                const ex = get('SELECT id FROM kas WHERE code=?', [k.kode||String(k.id)]);
                if (!ex) run('INSERT INTO kas (code,name,balance,type) VALUES (?,?,?,?)', [k.kode||String(k.id), k.nama, k.saldo||0, k.tipe||'Tunai']);
            }
            if (d.biaya) for (let b of d.biaya) {
                const ex = get('SELECT id FROM biaya WHERE code=?', [b.kode||String(b.id)]);
                if (!ex) run('INSERT INTO biaya (code,name,category,description) VALUES (?,?,?,?)', [b.kode||String(b.id), b.nama, b.kategori||'Operasional', b.keterangan||'']);
            }
        };
        tx();
        saveDatabase();
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sync/upload', (req, res) => {
    try {
        const d = req.body;
        const cabangId = d.cabangId || config.cabangId;
        if (d.inventory) {
            db.run('DELETE FROM products');
            for (let item of d.inventory) {
              const extra = {};
              if (item.stockCabang) extra.stockCabang = item.stockCabang;
              run('INSERT INTO products (sku,name,description,price,stock,category,cost_price,unit,extra_data) VALUES (?,?,?,?,?,?,?,?,?)', [item.kode, item.nama, item.catatan||'', item.hjual||0, item.stok||0, item.kategori||'', item.hbeli||0, item.satuan||'PCS', JSON.stringify(extra)]);
            }
        }
        if (d.penjualan) {
            db.run('DELETE FROM penjualan');
            for (let t of d.penjualan) run('INSERT INTO penjualan (no_faktur,tanggal,jam,keterangan,pelanggan,pelanggan_id,jumlah,subtotal,bayar,piutang,kas,jth_tempo,operator,jasa_kirim,biaya_kirim,items_data,kode_cabang) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [t.noFaktur, t.tanggal, t.jam||'', t.ket||'', t.pelanggan||'Umum', t.pelangganId||null, t.jumlah||0, t.subtotal||0, t.bayar||0, t.piutang||'', t.kas||'', t.jthTempo||'', t.operator||'Admin', t.jasaKirim||'', t.biayaKirim||0, JSON.stringify(t.items||[]), cabangId]);
        }
        if (d.pembelian) {
            db.run('DELETE FROM pembelian');
            for (let t of d.pembelian) run('INSERT INTO pembelian (no_faktur,tanggal,supplier,supplier_id,jumlah,kas,keterangan,metode,operator,kode_cabang) VALUES (?,?,?,?,?,?,?,?,?,?)', [t.noFaktur, t.tanggal, t.supplier, t.supplierId||null, t.jumlah||0, t.kas||'', t.keterangan||'', t.metode||'Tunai', t.operator||'Admin', cabangId]);
        }
        if (d.pelanggan) {
            db.run('DELETE FROM pelanggan');
            for (let p of d.pelanggan) run('INSERT INTO pelanggan (code,name,phone,address,email,credit_limit) VALUES (?,?,?,?,?,?)', [p.kode||String(p.id), p.nama, p.telp||'', p.alamat||'', p.email||'', p.batasPiutang||0]);
        }
        if (d.supplier) {
            db.run('DELETE FROM suppliers');
            for (let s of d.supplier) run('INSERT INTO suppliers (code,name,address,phone,balance) VALUES (?,?,?,?,?)', [s.kode||String(s.id), s.nama, s.alamat||'', s.telp||'', s.saldoHutang||0]);
        }
        if (d.kas) {
            db.run('DELETE FROM kas');
            for (let k of d.kas) run('INSERT INTO kas (code,name,balance,type) VALUES (?,?,?,?)', [k.kode||String(k.id), k.nama, k.saldo||0, k.tipe||'Tunai']);
        }
        if (d.biaya) {
            db.run('DELETE FROM biaya');
            for (let b of d.biaya) run('INSERT INTO biaya (code,name,category,description) VALUES (?,?,?,?)', [b.kode||String(b.id), b.nama, b.kategori||'Operasional', b.keterangan||'']);
        }
        saveDatabase();
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sync/info', (req, res) => {
    res.json({ cabangId: config.cabangId, cabangNama: config.cabangNama });
});

app.post('/api/sync/push', (req, res) => {
    try {
        const d = req.body;
        const cabangId = d.cabangId || config.cabangId;
        if (d.penjualan) {
            for (let t of d.penjualan) {
                const ex = get('SELECT id FROM penjualan WHERE no_faktur=? AND kode_cabang=?', [t.noFaktur, cabangId]);
                const itemsStr = JSON.stringify(t.items || []);
                if (ex) {
                    run('UPDATE penjualan SET tanggal=?,jam=?,keterangan=?,pelanggan=?,pelanggan_id=?,jumlah=?,subtotal=?,bayar=?,piutang=?,kas=?,jth_tempo=?,operator=?,jasa_kirim=?,biaya_kirim=?,items_data=?,kode_cabang=? WHERE id=?', [t.tanggal, t.jam, t.ket||'', t.pelanggan||'Umum', t.pelangganId||null, t.jumlah||0, t.subtotal||0, t.bayar||0, t.piutang||'', t.kas||'', t.jthTempo||'', t.operator||'Admin', t.jasaKirim||'', t.biayaKirim||0, itemsStr, cabangId, ex.id]);
                } else {
                    run('INSERT INTO penjualan (no_faktur,tanggal,jam,keterangan,pelanggan,pelanggan_id,jumlah,subtotal,bayar,piutang,kas,jth_tempo,operator,jasa_kirim,biaya_kirim,items_data,kode_cabang) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [t.noFaktur, t.tanggal, t.jam, t.ket||'', t.pelanggan||'Umum', t.pelangganId||null, t.jumlah||0, t.subtotal||0, t.bayar||0, t.piutang||'', t.kas||'', t.jthTempo||'', t.operator||'Admin', t.jasaKirim||'', t.biayaKirim||0, itemsStr, cabangId]);
                }
            }
        }
        if (d.pembelian) {
            for (let t of d.pembelian) {
                const ex = get('SELECT id FROM pembelian WHERE no_faktur=? AND kode_cabang=?', [t.noFaktur, cabangId]);
                if (ex) {
                    run('UPDATE pembelian SET tanggal=?,supplier=?,supplier_id=?,jumlah=?,kas=?,keterangan=?,metode=?,operator=?,kode_cabang=? WHERE id=?', [t.tanggal, t.supplier, t.supplierId||null, t.jumlah||0, t.kas||'', t.keterangan||'', t.metode||'Tunai', t.operator||'Admin', cabangId, ex.id]);
                } else {
                    run('INSERT INTO pembelian (no_faktur,tanggal,supplier,supplier_id,jumlah,kas,keterangan,metode,operator,kode_cabang) VALUES (?,?,?,?,?,?,?,?,?,?)', [t.noFaktur, t.tanggal, t.supplier, t.supplierId||null, t.jumlah||0, t.kas||'', t.keterangan||'', t.metode||'Tunai', t.operator||'Admin', cabangId]);
                }
            }
        }
        saveDatabase();
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/backup/list', (req, res) => {
    try {
        const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('backup-')).sort().reverse();
        res.json({ backups: files.map(f => ({ name: f, size: fs.statSync(path.join(BACKUP_DIR, f)).size, date: f.replace('backup-','').replace('.db','').replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/,'$1-$2-$3 $4:$5:$6') })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/backup/download/:name', (req, res) => {
    try {
        const filePath = path.join(BACKUP_DIR, req.params.name);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Backup not found' });
        res.download(filePath);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/backup/restore/:name', (req, res) => {
    try {
        const filePath = path.join(BACKUP_DIR, req.params.name);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Backup not found' });
        const buffer = fs.readFileSync(filePath);
        const newDb = new SQL_CONSTRUCTOR.Database(buffer);
        db.close();
        db = newDb;
        fs.writeFileSync(DB_PATH, buffer);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/backup/now', (req, res) => {
    try {
        const data = db.export();
        const buffer = Buffer.from(data);
        const ts = new Date().toISOString().slice(0,19).replace(/[:-]/g,'');
        fs.writeFileSync(path.join(BACKUP_DIR, 'backup-' + ts + '.db'), buffer);
        res.json({ ok: true, name: 'backup-' + ts + '.db' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Activation ----
// Ganti 'BISMILLAH' dengan kata kunci sendiri biar tambah aman
const ACTIVATION_SALT = 'BISMILLAH';

function generateActivationKey(nama, alamat) {
    var s = (nama||'').trim().toUpperCase()+'|'+(alamat||'').replace(/[\r\n]+/g,' ').replace(/\s+/g,' ').trim().toUpperCase()+'|'+ACTIVATION_SALT;
    var hash = 5381;
    for (var i = 0; i < s.length; i++) {
        hash = ((hash << 5) + hash) + s.charCodeAt(i);
        hash = hash & hash;
    }
    var key = '';
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var seed = Math.abs(hash);
    for (var i = 0; i < 20; i++) {
        seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
        key += chars.charAt(seed % chars.length);
        if (i === 4 || i === 9 || i === 14) key += '-';
    }
    return key;
}

app.get('/api/activation/status', (req, res) => {
    try {
        const row = get('SELECT data FROM settings WHERE id=1');
        if (row && row.data) {
            const d = JSON.parse(row.data);
            if (d.nama && d.key && d.key === generateActivationKey(d.nama, d.alamat || '')) {
                return res.json({ activated: true, nama: d.nama });
            }
        }
        res.json({ activated: false });
    } catch (e) { res.json({ activated: false }); }
});

app.post('/api/activation/activate', (req, res) => {
    try {
        const data = req.body;
        if (!data || !data.nama || !data.key) return res.status(400).json({ error: 'Data tidak valid' });
        const expected = generateActivationKey(data.nama, data.alamat || '');
        if (data.key !== expected) return res.status(400).json({ error: 'Key tidak valid' });
        run('INSERT OR REPLACE INTO settings (id,data) VALUES (1,?)', [JSON.stringify({ nama: data.nama, alamat: data.alamat || '', key: data.key })]);
        saveDatabase();
        res.json({ ok: true, nama: data.nama });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/activation/deactivate', (req, res) => {
    try {
        run('DELETE FROM settings WHERE id=1');
        saveDatabase();
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


async function startServer() {
    const SQL = await initSqlJs();
    SQL_CONSTRUCTOR = SQL;
    initDb(SQL);
    return new Promise((resolve, reject) => {
        const server = app.listen(PORT, config.bindIp || '0.0.0.0', () => {
            console.log('KasirPro server running on port ' + PORT);
            resolve(server);
        });
        server.once('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.error('Port ' + PORT + ' in use, using port 0 (auto-assign)');
                app.listen(0, config.bindIp || '0.0.0.0', () => {
                    const addr = app.address();
                    console.log('KasirPro server running on port ' + addr.port);
                    resolve(addr.port);
                });
            } else {
                reject(err);
            }
        });
    });
}

if (require.main === module) startServer().catch(e => { console.error(e); process.exit(1); });
module.exports = { startServer, app };
