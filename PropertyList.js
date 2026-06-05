/* ============================================================
   PropertyList.js

   Usage — call once per view after loading this script:

     PropertyList(window.top.prover, {
       rootId:               'pl-propertylist',   // id of the .pl-app div
       storageKey:           'propertylist-layout',
       dataUrl:              '/property/PropertyListJson',
       showOwnersSelectable: false,   // true -> owners plain-text (printable)
       maxResults:           500,     // server-configured cap; 0 = unlimited
     });

   Layout persistence uses prover.user.get/setSetting when available
   (embedded in the prover app), falling back to localStorage when the
   view is opened standalone (e.g. in a new window).

     prover.user.setSetting(key, value)                  -- fire-and-forget
     prover.user.getSetting(key, function(value) { })    -- async callback
   ============================================================ */

function PropertyList(prover, config) {

    const {
        rootId,
        storageKey,
        dataUrl,
        showOwnersSelectable = false,
        maxResults = 0,
    } = config;

    // Mutable so reload() can swap it without re-initialising the component.
    let dataValue = config.dataValue;

    // ── Root element & scoped query helpers ──────────────────────
    const root = document.getElementById(rootId);
    if(!root) {
        console.error('PropertyList: root element not found:', rootId);
        return;
    }

    // Scope all DOM queries to this instance's root element.
    function $(sel) {return root.querySelector(sel);}
    function $$(sel) {return root.querySelectorAll(sel);}

    // ── Column definitions ──────────────────────────────────────
    // Callers can inject a custom column list via config.cols at init time.
    // This is a one-time configuration — columns cannot be changed after init.
    //
    //   PropertyList(prover, { ..., cols: [
    //     { id: 'suburb', name: 'Suburb', group: 'Location', def: true },
    //     ...
    //   ]});
    //
    // If config.cols is absent or empty the built-in defaults below are used.
    const COLS = (config.cols && config.cols.length) ? config.cols : [
        {id: 'district',        name: 'District',          def: false},
        {id: 'suburb',          name: 'Suburb',            def: false},
        {id: 'owners',          name: 'Owners',            def: true,  noexport: true, noselect: true},
        {id: 'cv',              name: 'Capital value',     def: true},
        {id: 'lv',              name: 'Land value',        def: false},
        {id: 'land',            name: 'Land area',         def: true},
        {id: 'floor',           name: 'Floor area',        def: true},
        {id: 'age',             name: 'Bldg age',          def: false},
        {id: 'beds',            name: 'Bedrooms',          def: true},
        {id: 'baths',           name: 'Bathrooms',         def: true},
        {id: 'cars',            name: 'Car spaces',        def: false},
        {id: 'roof',            name: 'Roof',              def: false},
        {id: 'walls',           name: 'Walls / ext.',      def: false},
        {id: 'sprice',          name: 'Last sale price',   def: true},
        {id: 'sdate',           name: 'Last sale date',    def: true},
        {id: 'zone',            name: 'Zone',              def: false},
        {id: 'zoneDescription', name: 'Zone description',  def: false},
        {id: 'cat',             name: 'Category',          def: false},
        {id: 'use',             name: 'Land use',          def: false},
    ];


    // ── State ────────────────────────────────────────────────────
    let colOrder = COLS.map(c => c.id);
    let colVisible = {};
    COLS.forEach(c => {colVisible[c.id] = c.def;});

    let sortCol = null;
    let sortDir = 1;     // 1 = asc, -1 = desc
    let rows = [];

    // Drag state -- picker
    let pickerDragSrc = null;

    // Drag state -- table headers
    let hdrDragSrc = null;
    let hdrDragX = 0;
    let hdrDragMoved = false;

    // Save debounce
    let saveTimer = null;

    // ── Date / number helpers ────────────────────────────────────
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul',
        'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    function formatDate(iso) {
        if(!iso) return '\u2014';
        const d = new Date(iso);
        if(isNaN(d.getTime())) return '\u2014';
        return String(d.getDate()).padStart(2, '0') + '\u00a0' +
            MONTHS[d.getMonth()] + '\u00a0' + d.getFullYear();
    }

    function formatCurrency(val) {
        if(!val && val !== 0) return '\u2014';
        const n = Number(val);
        if(isNaN(n) || n === 0) return '\u2014';
        return '$' + n.toLocaleString('en-NZ');
    }

    function formatArea(val) {
        if(val == null || val === '') return '\u2014';
        const n = Number(val);
        if(isNaN(n) || n === 0) return '\u2014';
        if(n >= 10000) return (n / 10000).toFixed(2) + '\u00a0ha';
        return n.toLocaleString('en-NZ') + '\u00a0m\u00b2';
    }

    function esc(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ── Map server JSON to internal row object ────────────────────
    function mapRow(p) {

        function stars(quality) {
            if(!!quality) {   // 69 is char 'E'(converts A to D rating )
                //var c = 69 -(quality.toUpperCase()[0]).charCodeAt() ;
                // return star chars. REINZ 'A' is 4 stars - 'D' is one star
                return '\u2605'.repeat(quality) + '\u2606'.repeat(5 - quality);
            }
            else
                return '';
        }

        const cv = p.capitalValue || 0;
        const lv = p.landValue || 0;
        const sprice = p.lastSalePrice || 0;

        // owners can be either:
        //   [{owner: {name: '...'}, whitePagesLink}]  <- streetreport endpoint
        //   ['Name One', 'Name Two']                  <- plain-string endpoint
        const ownerNames = Array.isArray(p.owners)
            ? p.owners.map(o => (o && o.owner ? o.owner.name : o)).filter(Boolean)
            : p.owners ? [p.owners] : [];
        const ownerStr = ownerNames.length ? ownerNames.join(', ') : '\u2014';

        const addr = [p.address, p.suburb, p.town].filter(Boolean).join(', ');

        return {
            addr,
            suburb: p.suburb || '\u2014',
            district: p.town || '\u2014',
            zone: p.zone || '\u2014',
            zoneDescription: p.zoneDescription || '\u2014',
            owners: ownerStr,
            ownerNames: ownerNames.length ? ownerNames : ['\u2014'],
            cv, cvd: formatCurrency(cv),
            lv, lvd: formatCurrency(lv),
            land: formatArea(p.landArea),
            floor: formatArea(p.floorArea),
            // buildingAge can be {id, code, fullName} object or a plain string
            age: (p.buildingAge
                ? (typeof p.buildingAge === 'object' ? p.buildingAge.fullName : p.buildingAge)
                : null) || '\u2014',
            beds: p.bedrooms != null ? String(p.bedrooms) : '\u2014',
            baths: p.bathrooms != null ? String(p.bathrooms) : '\u2014',
            cars: p.carSpaces != null ? String(p.carSpaces) : '\u2014',
            roof: p.roofMaterial || '\u2014',
            walls: p.wallMaterial || '\u2014',
            type: p.marketType || '\u2014',
            sprice, spriced: formatCurrency(sprice),
            sdate: formatDate(p.lastSaleDate),
            cat: p.category || '\u2014',
            use: p.landUseText || '\u2014',
            listName: p.listName || '',
            automatedValuationModelPrice: formatCurrency(p.automatedValuationModelPrice),
            automatedValuationModelQuality: stars(p.automatedValuationModelQuality),
            details: `<a href="#" class="details btn" data-valref='${p.valref}'>Details</a>`
        };
    }

    // ── Persistence -- prover.user.get/setSetting with localStorage fallback ──
    //
    // prover.user.getSetting is async (callback-based), so loadLayout accepts
    // a `done` callback invoked once the layout has been applied.  The boot
    // sequence runs inside that callback so the layout is always applied before
    // the first render regardless of which backend resolves first.

    function _useProver() {
        return typeof prover !== 'undefined' &&
            prover &&
            prover.user &&
            typeof prover.user.getSetting === 'function' &&
            typeof prover.user.setSetting === 'function';
    }

    function _persistLoad(done) {
        if(_useProver()) {
            try {
                prover.user.getSetting(storageKey, function(value) {
                    done(value != null ? value : null);
                });
                return;
            } catch(e) {
                console.warn('PropertyList: prover.user.getSetting failed, using localStorage:', e);
            }
        }
        try {
            done(localStorage.getItem(storageKey));
        } catch(e) {
            console.warn('PropertyList: localStorage read failed:', e);
            done(null);
        }
    }

    // prover receives the plain object; localStorage receives a JSON string.
    function _persistSave(data) {
        if(_useProver()) {
            try {
                prover.user.setSetting(storageKey, data);
                return;
            } catch(e) {
                console.warn('PropertyList: prover.user.setSetting failed, using localStorage:', e);
            }
        }
        try {
            localStorage.setItem(storageKey, JSON.stringify(data));
        } catch(e) {
            console.warn('PropertyList: localStorage write failed:', e);
        }
    }

    // Apply a saved layout object (or JSON string) to colOrder / colVisible.
    function _applyLayout(raw) {
        if(!raw) return false;
        try {
            const saved = (typeof raw === 'string') ? JSON.parse(raw) : raw;

            if(Array.isArray(saved.colOrder)) {
                const validIds = new Set(COLS.map(c => c.id));
                const savedValid = saved.colOrder.filter(id => validIds.has(id));
                const missing = COLS.map(c => c.id).filter(id => !savedValid.includes(id));
                colOrder = [...savedValid, ...missing];
            }

            if(saved.colVisible && typeof saved.colVisible === 'object') {
                Object.keys(saved.colVisible).forEach(id => {
                    if(!Object.prototype.hasOwnProperty.call(colVisible, id)) return;
                    const col = COLS.find(c => c.id === id);
                    if(col && col.hidden) return;   // never restore a server-suppressed column
                    colVisible[id] = saved.colVisible[id];
                });
            }

            return true;
        } catch(e) {
            console.warn('PropertyList: could not apply saved layout:', e);
            return false;
        }
    }

    function loadLayout(done) {
        _persistLoad(function(raw) {
            const restored = _applyLayout(raw);

            if(restored) {
                const tip = $('#persist-tip');
                if(tip) {
                    tip.innerHTML = '<i class="ti ti-device-floppy" aria-hidden="true"></i>Layout restored';
                    setTimeout(() => {
                        tip.innerHTML = '<i class="ti ti-device-floppy" aria-hidden="true"></i>Layout saved';
                    }, 2000);
                }
            }

            if(typeof done === 'function') done();
        });
    }

    function saveLayout() {
        _persistSave({colOrder, colVisible});
        flashSaveDot();
    }

    function schedSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveLayout, 400);
    }

    function flashSaveDot() {
        const dot = $('#save-dot');
        if(!dot) return;
        dot.classList.add('show');
        clearTimeout(dot._timer);
        dot._timer = setTimeout(() => dot.classList.remove('show'), 1400);
    }

    // ── CSV export ───────────────────────────────────────────────
    function csvEscape(val) {
        const s = String(val === null || val === undefined ? '' : val).replace(/\u2014/g, '');
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    function rawVal(row, id) {
        if(id === 'cv') return row.cv || '';
        if(id === 'lv') return row.lv || '';
        if(id === 'sprice') return row.sprice || '';
        return row[id] || '';
    }

    function exportCSV() {
        const vc = visCols().filter(c => !c.noexport);
        const headers = ['Address', ...vc.map(c => c.name)];
        const csvRows = [headers.map(csvEscape).join(',')];

        rows.forEach(r => {
            csvRows.push([
                csvEscape(r.addr),
                ...vc.map(c => csvEscape(rawVal(r, c.id))),
            ].join(','));
        });

        // Prepend UTF-8 BOM so Excel opens with correct encoding.
        const blob = new Blob(['\uFEFF', csvRows.join('\r\n')], {type: 'text/csv;charset=utf-8;'});
        const url  = URL.createObjectURL(blob);
        const btn  = $('#btn-export-csv');
        const a    = $('#btn-export-csv-hidden-download');

        if(btn) {btn.disabled = true; btn.style.opacity = '0.6'; btn.style.pointerEvents = 'none';}
        if(a)   {a.href = url; a.download = 'properties.csv'; a.click();}

        setTimeout(() => {
            if(btn) {btn.disabled = false; btn.style.opacity = '1'; btn.style.pointerEvents = 'auto';}
            URL.revokeObjectURL(url);
        }, 1000);
    }

    // ── Helpers ──────────────────────────────────────────────────
    function visCols() {
        return colOrder
            .filter(id => colVisible[id])
            .map(id => COLS.find(c => c.id === id));
    }

    function getSortVal(row, id) {
        if(['cv', 'lv', 'sprice', 'age'].includes(id)) {
            const n = Number(row[id]);
            return isNaN(n) || row[id] === '\u2014' ? -Infinity : n;
        }
        if(['beds', 'baths', 'cars'].includes(id)) {
            return row[id] === '\u2014' ? -Infinity : Number(row[id]);
        }
        return (row[id] || '').toString().toLowerCase();
    }

    function sortRows() {
        if(!sortCol) return;
        rows.sort((a, b) => {
            const av = getSortVal(a, sortCol);
            const bv = getSortVal(b, sortCol);
            if(av < bv) return -sortDir;
            if(av > bv) return sortDir;
            return 0;
        });
    }

    function cellHtml(row, id) {
        if(id === 'owners') {
            const names = row.ownerNames || [row.owners || '\u2014'];
            if(showOwnersSelectable) {
                // Plain text -- printable and copyable; one owner per line.
                return names.map(esc).join('<br>');
            }
            // Privacy-protect each name separately via CSS ::before so the
            // value cannot be selected, copied, or captured by browser print.
            return names.map(n => '<span data-pseudo-content="' + esc(n) + '"></span>').join('<br>');
        }
        if(id === 'cat') {
            const cls = row.cat === 'OE' ? 'pill-oe' : 'pill-res';
            return '<span class="pill ' + cls + '">' + row.cat + '</span>';
        }
        if(id === 'cv') return row.cvd;
        if(id === 'lv') return row.lvd;
        if(id === 'sprice') return row.spriced;
        const v = row[id];
        return (v === null || v === undefined || v === '') ? '\u2014' : v;
    }

    function reorderCol(srcId, tgtId, after) {
        const si = colOrder.indexOf(srcId);
        colOrder.splice(si, 1);
        const ti = colOrder.indexOf(tgtId);
        colOrder.splice(after ? ti + 1 : ti, 0, srcId);
    }

    function flashPickerItem(id) {
        const el = $$(`.col-item[data-id="${id}"]`)[0];
        if(!el) return;
        el.classList.remove('just-moved');
        void el.offsetWidth;
        el.classList.add('just-moved');
    }

    // ── Loading / error / warning states ─────────────────────────
    function showLoading() {
        const tbody = $('#table-body');
        if(tbody) {
            tbody.innerHTML =
                '<tr><td colspan="20" style="text-align:center;padding:32px;color:#6b7280">' +
                '<i class="ti ti-refresh" style="font-size:20px;display:block;margin-bottom:8px;animation:spin 1s linear infinite"></i>' +
                'Loading properties\u2026</td></tr>';
        }
    }

    function showError(msg) {
        const tbody = $('#table-body');
        if(tbody) {
            tbody.innerHTML =
                '<tr><td colspan="20" style="text-align:center;padding:32px;color:#dc2626">' +
                '<i class="ti ti-alert-circle" style="font-size:20px;display:block;margin-bottom:8px"></i>' +
                (msg || 'Error loading data. Please refresh and try again.') +
                '</td></tr>';
        }
    }

    function setTruncationWarning(total, max) {
        let el = root.querySelector('.pl-truncation-warning');
        if(!el) {
            el = document.createElement('div');
            el.className = 'pl-truncation-warning truncation-warning';
            const footer = root.querySelector('.footer');
            if(footer) root.insertBefore(el, footer);
            else root.appendChild(el);
        }
        el.textContent =
            'Warning: Results truncated to ' + max.toLocaleString() + ' of ' + total.toLocaleString() + ' properties.';
    }

    // ── Data fetch ───────────────────────────────────────────────
    function loadData() {
        showLoading();
        const opts = dataValue
            ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(dataValue)}
            : undefined;
        fetch(dataUrl, opts)
            .then(r => {
                if(!r.ok) throw new Error('HTTP\u00a0' + r.status);
                return r.json();
            })
            .then(data => {
                const maxLen = (maxResults > 0) ? maxResults : Infinity;
                if(data.length > maxLen) {
                    setTruncationWarning(data.length, maxLen);
                    data.length = maxLen;
                }
                rows = data.map(mapRow);
                render();
            })
            .catch(err => {
                console.error('PropertyList fetch error:', err);
                showError();
            });
    }

    // ── Render ───────────────────────────────────────────────────
    function render() {
        renderTable();
        buildPicker();

        const renderEvent = new CustomEvent('plRenderComplete', {
            detail: {
                rowCount: rows.length,
                visibleColumns: visCols().map(c => c.id)
            },
            bubbles: true,     // Allows the event to bubble up the DOM
            cancelable: false
        });

        root.dispatchEvent(renderEvent);

    }

    function renderTable() {
        const vc = visCols();

        const visCount = $('#vis-count');
        if(visCount) visCount.textContent = (vc.length + 1) + '\u00a0cols';

        const headerInfo = $('#header-info');
        if(headerInfo) {
            headerInfo.textContent =
                rows.length.toLocaleString() + ' properties \u00b7 ' + (vc.length + 1) + ' columns';
        }


        const footerInfo = $('#footer-info');
        if(footerInfo) {
            footerInfo.textContent =
                rows.length.toLocaleString() + ' properties \u00b7 ' + (vc.length + 1) + ' columns';
        }

        const addrDir  = sortCol === 'addr' ? (sortDir === 1 ? 'asc' : 'desc') : '';
        const addrIcon = addrDir === 'asc' ? 'ti-sort-ascending'
            : addrDir === 'desc' ? 'ti-sort-descending'
            : 'ti-arrows-sort';

        const colRow =
            '<tr>' +
            '<th class="ch sticky-ch" style="min-width:220px" data-colid="addr"><div class="ch-inner">Address' +
            ' <i class="ti ' + addrIcon + ' sort-icon ' + addrDir + '" aria-hidden="true"></i>' +
            '</div></th>' +
            vc.map(c => {
                const active = sortCol === c.id;
                const dir = active ? (sortDir === 1 ? 'asc' : 'desc') : '';
                const icon = dir === 'asc' ? 'ti-sort-ascending'
                    : dir === 'desc' ? 'ti-sort-descending'
                        : 'ti-arrows-sort';
                const extra = c.noselect ? ' noprint noselect' : '';
                return '<th class="ch' + extra + '" style="min-width:95px" data-colid="' + c.id + '">' +
                    '<div class="ch-inner">' + c.name +
                    ' <i class="ti ' + icon + ' sort-icon ' + dir + '" aria-hidden="true"></i>' +
                    '</div></th>';
            }).join('') +
            '</tr>';

        const thead = $('#table-head');
        if(thead) thead.innerHTML = colRow;

        sortRows();
        const tbody = $('#table-body');
        if(tbody) {
            tbody.innerHTML = rows.map(r =>
                '<tr>' +
                '<td class="sticky-td">' + r.addr + '</td>' +
                vc.map(c => {
                    let cls = c.noselect ? 'noprint noselect' : '';
                    if(c.id === 'owners') cls = (cls ? cls + ' ' : '') + 'owners-td';
                    return '<td class="' + cls + '">' + cellHtml(r, c.id) + '</td>';
                }).join('') +
                '</tr>'
            ).join('');
        }

        attachHeaderEvents();
    }

    // ── Table header drag & sort ──────────────────────────────────
    function attachHeaderEvents() {
        $$('#main-table .ch[data-colid]').forEach(th => {

            th.addEventListener('mousedown', e => {
                hdrDragSrc = th;
                hdrDragX = e.clientX;
                hdrDragMoved = false;
            });

            th.addEventListener('click', () => {
                if(hdrDragMoved) return;
                const id = th.dataset.colid;
                if(sortCol === id) sortDir *= -1;
                else {sortCol = id; sortDir = 1;}
                render();
            });

            th.addEventListener('mousemove', e => {
                if(!hdrDragSrc || hdrDragSrc === th) return;
                if(!hdrDragMoved && Math.abs(e.clientX - hdrDragX) < 5) return;
                hdrDragMoved = true;
                clearHeaderDragStyles();
                hdrDragSrc.classList.add('dragging-col');
                const rect = th.getBoundingClientRect();
                const side = e.clientX < rect.left + rect.width / 2
                    ? 'col-drag-over-left'
                    : 'col-drag-over-right';
                th.classList.add(side);
            });

            th.addEventListener('mouseup', e => {
                if(!hdrDragSrc || !hdrDragMoved) {hdrDragSrc = null; return;}
                const src = hdrDragSrc.dataset.colid;
                const tgt = th.dataset.colid;
                if(src && tgt && src !== tgt) {
                    const rect = th.getBoundingClientRect();
                    const after = e.clientX >= rect.left + rect.width / 2;
                    reorderCol(src, tgt, after);
                    render();
                    flashPickerItem(src);
                    schedSave();
                } else {
                    render();
                }
                hdrDragSrc = null;
                hdrDragMoved = false;
            });
        });
    }

    function clearHeaderDragStyles() {
        $$('#main-table .ch[data-colid]').forEach(t =>
            t.classList.remove('col-drag-over-left', 'col-drag-over-right', 'dragging-col'));
    }

    // Global mouseup cleans up any in-progress header drag (e.g. mouse released
    // outside the table). Bound once per instance; harmless if both fire.
    document.addEventListener('mouseup', () => {
        if(hdrDragSrc) {
            hdrDragSrc = null; hdrDragMoved = false;
            clearHeaderDragStyles();
        }
    });

    // ── Picker panel ─────────────────────────────────────────────
    function buildPicker() {
        const body = $('#picker-body');
        if(!body) return;
        const scrollTop = body.scrollTop;
        body.innerHTML = '';

        colOrder.forEach(id => {
            const c = COLS.find(x => x.id === id);
            if(!c || c.hidden) return;   // don't expose server-suppressed columns

            // Prefix checkbox id with rootId so two instances on the same page
            // never produce duplicate id values (label[for] is document-scoped).
            const cbId = 'pk-' + rootId + '-' + id;

            const item = document.createElement('div');
            item.className = 'col-item';
            item.draggable = true;
            item.dataset.id = id;
            item.innerHTML =
                '<i class="ti ti-grip-vertical drag-handle" aria-hidden="true"></i>' +
                '<input type="checkbox" id="' + cbId + '"' + (colVisible[id] ? ' checked' : '') + '>' +
                '<label for="' + cbId + '">' +
                c.name +
                (c.noexport
                    ? ' <i class="ti ti-lock" aria-label="Not exported" title="Excluded from CSV export" style="font-size:11px;color:#9ca3af;margin-left:3px"></i>'
                    : '') +
                '</label>';

            item.querySelector('input').addEventListener('change', e => {
                colVisible[id] = e.target.checked;
                render();
                schedSave();
            });

            item.addEventListener('dragstart', e => {
                pickerDragSrc = id;
                item.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
            });
            item.addEventListener('dragend', () => {
                item.classList.remove('dragging');
                $$('.col-item').forEach(el => el.classList.remove('drag-over'));
            });
            item.addEventListener('dragover', e => {
                e.preventDefault();
                $$('.col-item').forEach(el => el.classList.remove('drag-over'));
                item.classList.add('drag-over');
            });
            item.addEventListener('drop', e => {
                e.preventDefault();
                const tgt = item.dataset.id;
                if(pickerDragSrc && tgt && pickerDragSrc !== tgt) {
                    reorderCol(pickerDragSrc, tgt, false);
                    render();
                    schedSave();
                }
                pickerDragSrc = null;
            });

            body.appendChild(item);
        });

        body.scrollTop = scrollTop;
    }

    // ── Toolbar actions ──────────────────────────────────────────
    function plTogglePanel() {
        const panel = $('#picker-panel');
        const btn = $('#col-toggle-btn');
        if(!panel || !btn) return;
        const hidden = panel.classList.toggle('hidden');
        btn.className = hidden ? 'btn' : 'btn btn-active';
    }

    function plSelectAll() {
        COLS.forEach(c => {if(!c.hidden) colVisible[c.id] = true;});
        render(); schedSave();
    }

    function plSelectNone() {
        COLS.forEach(c => {colVisible[c.id] = false;});
        render(); schedSave();
    }

    function plResetDefault() {
        colOrder = COLS.map(c => c.id);
        COLS.forEach(c => {colVisible[c.id] = c.hidden ? false : c.def;});
        sortCol = null;
        sortDir = 1;
        render();
        saveLayout();
    }

    // ── Wire up toolbar buttons ───────────────────────────────────
    // Buttons carry no onclick attributes -- all handlers are bound here so
    // they close over this instance's state rather than the global scope.
    function _btn(sel, fn) {const el = $(sel); if(el) el.onclick = fn;}

    _btn('#col-toggle-btn', plTogglePanel);
    _btn('#btn-select-all', plSelectAll);
    _btn('#btn-select-none', plSelectNone);
    _btn('#btn-reset', plResetDefault);
    _btn('#btn-export-csv', exportCSV);

    // ── Public API ────────────────────────────────────────────────
    // Returns an object so the caller can trigger a fresh fetch without
    // tearing down and rebuilding the whole component (layout, column
    // order, sort state, etc. are all preserved between reloads).
    //
    //   const pl = PropertyList(prover, { dataUrl, ... });
    //   pl.reload({ suburbId: 42, streetFilter: [...], ... });
    //
    function reload(newDataValue) {
        dataValue = newDataValue;
        loadData();
    }

    // ── Boot ─────────────────────────────────────────────────────
    // loadLayout is async (prover.user.getSetting uses a callback), so
    // buildPicker and loadData run inside the done-callback to guarantee
    // the restored layout is applied before the first render.
    loadLayout(function() {
        buildPicker();
        loadData();
    });

    return { reload };

} // end PropertyList()