/** 单台与批量共用同一份型号模板；每台保留 IMEI 与覆盖值。 */
const api = require('../../../api/index');
const { PERM } = require('../../../constants/roles');
const { ROUTES } = require('../../../utils/router');
const events = require('../../../utils/events');
const { scanImei } = require('../../../utils/scan');
const { isImei } = require('../../../utils/validate');
const { initialValues, validateValues } = require('../../../utils/template');
const { upload } = require('../../../utils/request');
const auth = require('../../../utils/auth');
const drafts = require('./draft');
let sequence = 0;
function row() { return { key: `row_${++sequence}`, imei1: '', imei2: '', state: '', message: '', matchModelId: '', expanded: false, attributes: {}, cost: '' }; }
module.exports = function inboundPage(batch) {
  return {
    requireStaff: true, permission: PERM.INBOUND,
    data: {
      batch, model: null, modelLoading: false, templateId: '', templateVersion: 0, templateFields: [], parameterFields: [], imageFields: [], rowFields: [], attributes: {},
      hasDraft: false, restoringDraft: false, checkingSubmission: false,
      rows: [row()], costPresets: [], submitting: false, uploading: false, fieldUploads: 0, descriptionPresets: { peer: [], customer: [] },
      form: { condition: 'used', inspectionConfirmed: false, cost: '', wholesale: '', retail: '', agentBase: '', targetProfit: '', peerDesc: '', customerDesc: '', internalNote: '', publicImages: [], flags: { showInShop: true, sharePeer: true, shareAgent: false } }
    },
    onLoad() {
      this.draftKey = drafts.keyFor(auth.getCachedUser(), batch);
      try { this.setData({ hasDraft: !!(this.draftKey && wx.getStorageSync(this.draftKey)?.savedAt) }); } catch (error) {}
      this.offModel = events.on('inbound:model-selected', model => { const pages = getCurrentPages(); if (pages[pages.length - 2] === this) this.selectModel(model); });
    },
    onUnload() { if (this.offModel) this.offModel(); clearTimeout(this.suggestTimer); this.destroyed = true; },
    draftAvailable() {
      return this.draftKey && this.draftKey === drafts.keyFor(auth.getCachedUser(), batch);
    },
    draftBusy() {
      return this.data.submitting || this.data.modelLoading || this.data.uploading || this.data.fieldUploads > 0 || this.data.restoringDraft || this.data.checkingSubmission;
    },
    onSaveDraft() {
      if (this.draftBusy()) return;
      if (!this.draftAvailable()) return this.$toast('请重新登录后保存草稿');
      try {
        const draft = drafts.snapshot(this.data, this.priceTouched);
        wx.setStorageSync(this.draftKey, draft);
        this.activeDraftSavedAt = draft.savedAt;
        this.setData({ hasDraft: true });
        this.$toast('草稿已保存到本机');
      } catch (error) { this.$toast('草稿保存失败，请检查微信存储空间'); }
    },
    onRestoreDraft() {
      if (this.draftBusy() || !this.draftAvailable()) return;
      wx.showModal({ title: '恢复入库草稿', content: '恢复会替换当前页面的填写内容。', success: result => {
        if (result.confirm) this.restoreDraft();
      } });
    },
    async restoreDraft() {
      if (this.destroyed || this.draftBusy() || !this.draftAvailable()) return;
      this.setData({ restoringDraft: true });
      wx.showLoading({ title: '恢复草稿中', mask: true });
      let notice = '';
      let restoredRows = [];
      try {
        const saved = wx.getStorageSync(this.draftKey);
        if (!saved?.savedAt || !saved.rows?.length) throw Error('没有可恢复的草稿');
        const model = saved.model;
        const [template, costPresets] = model
          ? await Promise.all([api.template.modelForm(model.id), api.inbound.costPresets({ modelId: model.id })])
          : [null, []];
        const templatePatch = this.templateData(model, template, costPresets);
        const values = drafts.restoredValues(saved, template, templatePatch.rowFields);
        const fileGroups = [saved.form.publicImages, ...templatePatch.imageFields.map(field => values.attributes[field.key])];
        const fileFailed = await drafts.refreshFiles(fileGroups, api.file.detail);
        if (this.destroyed || !this.draftAvailable()) return;
        clearTimeout(this.suggestTimer);
        this.priceRevision = (this.priceRevision || 0) + 1;
        this.priceTouched = saved.priceTouched;
        this.activeDraftSavedAt = saved.savedAt;
        restoredRows = values.rows.map(savedRow => ({ ...row(), ...savedRow }));
        this.setData({
          ...templatePatch,
          rows: restoredRows,
          attributes: values.attributes,
          form: { ...this.data.form, ...saved.form, inspectionConfirmed: false },
        });
        notice = values.changed ? '模板已更新，请补核参数' : '草稿已恢复，请重新确认实机验收';
        if (fileFailed) notice += '，部分附件暂不可预览';
      } catch (error) {
        notice = error.message || '草稿恢复失败，请重试';
      } finally {
        wx.hideLoading();
        if (!this.destroyed) this.setData({ restoringDraft: false });
      }
      if (this.destroyed) return;
      if (notice) this.$toast(notice);
      // 批量草稿在提交时分组校验。
      if (!batch && restoredRows[0]?.imei1) this.checkRow(restoredRows[0].key, false);
    },
    onDeleteDraft() {
      if (this.draftBusy() || !this.draftAvailable()) return;
      wx.showModal({ title: '删除草稿', content: '删除本机保存的这份入库草稿？', success: result => {
        if (result.confirm && this.draftAvailable() && !this.draftBusy()) this.clearDraft();
      } });
    },
    clearDraft(onlyActive = false) {
      if (!this.draftKey) return;
      try {
        if (onlyActive && (!this.activeDraftSavedAt || wx.getStorageSync(this.draftKey)?.savedAt !== this.activeDraftSavedAt)) return;
        wx.removeStorageSync(this.draftKey);
        this.activeDraftSavedAt = undefined;
        if (!this.destroyed) this.setData({ hasDraft: false });
      } catch (error) { this.$toast('草稿未能清除，请手动删除'); }
    },
    onSwitchMode(e) {
      if (this.draftBusy()) return;
      if ((e.currentTarget.dataset.mode === 'batch') === batch) return;
      const go = () => this.$go(batch ? ROUTES.INBOUND : ROUTES.INBOUND_BATCH);
      wx.showModal({ title: '切换入库方式', content: '切换后请重新选择型号并填写，本页未提交内容不会带入。', success: r => { if (r.confirm) go(); } });
    },
    onChooseModel() { if (!this.draftBusy()) this.$go(ROUTES.TEMPLATES, { select: '1' }); },
    templateData(model, template, costPresets) {
      const fields = template?.fields || [];
      return {
        model, templateId: template?.id || '', templateVersion: template?.version || 0,
        templateFields: fields,
        parameterFields: fields.filter(field => field.type !== 'image'),
        imageFields: fields.filter(field => field.type === 'image'),
        rowFields: fields.filter(field => ['battery', 'grade', 'refurbishment'].includes(field.key)),
        descriptionPresets: template?.descriptionPresets || { peer: [], customer: [] },
        costPresets,
      };
    },
    selectModel(model) {
      if (this.data.submitting || this.data.fieldUploads || this.data.uploading) return this.$toast('请等待上传完成');
      if (this.data.restoringDraft || this.data.checkingSubmission) return;
      const revision = this.modelRevision = (this.modelRevision || 0) + 1;
      this.setData({ modelLoading: true });
      return Promise.all([api.template.modelForm(model.id), api.inbound.costPresets({ modelId: model.id })]).then(([template, costPresets]) => {
        if (this.destroyed || revision !== this.modelRevision) return;
        const rows = this.data.rows.map(r => ({ ...r, attributes: {} }));
        this.setData({ ...this.templateData(model, template, costPresets), attributes: initialValues(template.fields), rows });
      }).catch(e => this.$toast(e.message)).finally(() => { if (!this.destroyed && revision === this.modelRevision) this.setData({ modelLoading: false }); });
    },
    onCondition(e) { if (!this.data.submitting) this.setData({ 'form.condition': e.currentTarget.dataset.value }); },
    onInput(e) {
      const key = e.currentTarget.dataset.field;
      if (this.data.submitting) return;
      this.setData({ [`form.${key}`]: e.detail.value });
      this.priceRevision = (this.priceRevision || 0) + 1;
      if (['retail', 'wholesale', 'agentBase'].includes(key)) { this.priceTouched = this.priceTouched || {}; this.priceTouched[key] = true; }
      if (['cost', 'targetProfit'].includes(key)) this.suggest();
    },
    onFieldBusy(e) { this.setData({ fieldUploads: Math.max(0, this.data.fieldUploads + (e.detail.busy ? 1 : -1)) }); },
    onAttributeChange(e) { if (!this.data.submitting) this.setData({ [`attributes.${e.detail.key}`]: e.detail.value }); },
    onRowAttribute(e) {
      const index = this.data.rows.findIndex(r => r.key === e.currentTarget.dataset.row);
      if (index >= 0 && !this.data.submitting) this.setData({ [`rows[${index}].attributes.${e.detail.key}`]: e.detail.value });
    },
    onRowInput(e) {
      const { row: key, field } = e.currentTarget.dataset;
      const index = this.data.rows.findIndex(r => r.key === key);
      if (index < 0 || this.data.submitting) return;
      const patch = { [`rows[${index}].${field}`]: e.detail.value };
      if (field === 'imei1') Object.assign(patch, { [`rows[${index}].state`]: '', [`rows[${index}].message`]: '', [`rows[${index}].matchModelId`]: '' });
      this.setData(patch);
    },
    onImeiBlur(e) { this.checkRow(e.currentTarget.dataset.row); },
    setRow(key, patch) {
      if (this.destroyed) return;
      const index = this.data.rows.findIndex(r => r.key === key);
      if (index < 0) return;
      const update = {}; Object.keys(patch).forEach(k => { update[`rows[${index}].${k}`] = patch[k]; }); this.setData(update);
    },
    checkRow(key, promptModel = true) {
      const current = this.data.rows.find(r => r.key === key); if (!current) return;
      const imei = current.imei1;
      if (!isImei(imei)) { this.setRow(key, { state: 'invalid', message: 'IMEI1 需为有效的 15 位串码' }); return Promise.resolve(); }
      if (this.data.rows.some(r => r.key !== key && (r.imei1 === imei || r.imei2 === imei))) { this.setRow(key, { state: 'dup', message: '与本批其他设备串码重复' }); return Promise.resolve(); }
      const checks = this.rowChecks ||= new Map();
      const previous = checks.get(key);
      if (previous?.imei === imei) return previous.promise;
      this.setRow(key, { state: 'checking', message: '正在校验与识别…' });
      const promise = Promise.all([api.inbound.checkImei({ imei }), api.inbound.identifyModel({ imei })]).then(([check, result]) => {
        const latest = this.data.rows.find(r => r.key === key);
        if (!latest || latest.imei1 !== imei || checks.get(key)?.promise !== promise || this.destroyed) return;
        if (!check.unique) return this.setRow(key, { state: 'dup', message: '串码已存在，不能重复入库' });
        this.setRow(key, { state: 'ok', message: result.matched ? `识别型号：${result.model.name}，请核对实机` : `串码校验通过。 ${result.message || '型号请手动选择'}`, matchModelId: result.matched ? result.model.id : '' });
        if (promptModel && !this.data.checkingSubmission && result.matched && (!this.data.model || this.data.model.id !== result.model.id)) {
          wx.showModal({ title: '识别到型号', content: `${result.model.name}\n${result.message}\n是否使用该型号并重新加载公共参数？`, success: r => {
            const latest = this.data.rows.find(r => r.key === key);
            if (r.confirm && latest && latest.imei1 === imei) this.selectModel(result.model);
          } });
        }
      }).catch(e => {
        const latest = this.data.rows.find(r => r.key === key);
        if (latest?.imei1 === imei && checks.get(key)?.promise === promise)
          this.setRow(key, { state: 'invalid', message: e.message || '校验失败，请重试' });
      }).finally(() => {
        if (checks.get(key)?.promise === promise) checks.delete(key);
      });
      checks.set(key, { imei, promise });
      return promise;
    },
    onScan(e) {
      if (this.data.submitting) return;
      let key = e.currentTarget.dataset.row;
      scanImei().then(({ imei }) => {
        if (!key) {
          const empty = this.data.rows.find(r => !r.imei1);
          if (empty) key = empty.key;
          else { if (this.data.rows.length >= 100) return this.$toast('每批最多 100 台'); const next = row(); key = next.key; this.setData({ rows: this.data.rows.concat(next) }); }
        }
        this.setRow(key, { imei1: imei, state: '', matchModelId: '' }); this.checkRow(key);
      }).catch(() => null);
    },
    onAddRow() { if (!this.data.submitting && this.data.rows.length < 100) this.setData({ rows: this.data.rows.concat(row()) }); },
    onRemoveRow(e) { if (!this.data.submitting && this.data.rows.length > 1) this.setData({ rows: this.data.rows.filter(r => r.key !== e.currentTarget.dataset.row) }); },
    onToggleRow(e) { const current = this.data.rows.find(r => r.key === e.currentTarget.dataset.row); if (current && !this.data.submitting) this.setRow(current.key, { expanded: !current.expanded }); },
    onResetOverrides(e) { if (this.data.submitting) return; this.setRow(e.currentTarget.dataset.row, { attributes: {}, cost: '' }); },
    onCostPreset(e) { if (this.data.submitting) return; this.setData({ 'form.cost': String(e.currentTarget.dataset.cost) }); this.priceRevision = (this.priceRevision || 0) + 1; this.suggest(); },
    suggest() {
      clearTimeout(this.suggestTimer);
      this.suggestTimer = setTimeout(() => {
        const { cost, targetProfit } = this.data.form; if (cost === '') return;
        const revision = this.priceRevision;
        api.inbound.suggestPrice({ cost: Number(cost), targetProfit: Number(targetProfit) || 0 }).then(result => {
          if (this.destroyed || revision !== this.priceRevision) return;
          const patch = {}; ['retail', 'wholesale', 'agentBase'].forEach(key => { if (!(this.priceTouched || {})[key]) patch[`form.${key}`] = String(result[key]); }); this.setData(patch);
        }).catch(() => null);
      }, 300);
    },
    onFlagChange(e) { if (!this.data.submitting) this.setData({ [`form.flags.${e.currentTarget.dataset.flag}`]: e.detail.value }); },
    onQuickDescription(e) {
      if (this.data.submitting) return;
      const channel = e.currentTarget.dataset.channel, list = this.data.descriptionPresets[channel] || [];
      if (!list.length) return this.$toast('可在模板配置中添加快捷描述');
      wx.showActionSheet({ itemList: list, success: r => this.setData({ [`form.${channel === 'peer' ? 'peerDesc' : 'customerDesc'}`]: list[r.tapIndex] }) });
    },
    onChooseMedia() {
      if (this.data.submitting || this.data.uploading || this.data.form.publicImages.length >= 9) return;
      this.setData({ uploading: true });
      wx.chooseMedia({ count: 9 - this.data.form.publicImages.length, mediaType: ['image', 'video'], sizeType: ['compressed'] })
        .then(res => Promise.all(res.tempFiles.map(f => upload({ filePath: f.tempFilePath, scope: 'public', bizType: 'unit' }).then(file => ({ ...file, mediaType: f.fileType || 'image' })))))
        .then(files => this.setData({ 'form.publicImages': this.data.form.publicImages.concat(files) }))
        .catch(e => { if (!String(e.errMsg || '').includes('cancel')) this.$toast('上传未完成，请重试'); })
        .finally(() => this.setData({ uploading: false }));
    },
    onMediaAction(e) {
      if (this.data.submitting) return;
      const { index, action } = e.currentTarget.dataset, list = this.data.form.publicImages.slice(), i = Number(index);
      if (action === 'delete') list.splice(i, 1);
      else { const target = i + Number(action); if (target < 0 || target >= list.length) return; [list[i], list[target]] = [list[target], list[i]]; }
      this.setData({ 'form.publicImages': list });
    },
    onSubmit() {
      if (this.draftBusy()) return;
      return this.submitWithChecks();
    },
    async submitWithChecks() {
      if (!this.data.model) return this.$toast('请先选择型号');
      if (!this.data.form.inspectionConfirmed) return this.$toast('请先确认已完成逐台实机验收');
      this.setData({ checkingSubmission: true });
      try {
        const pending = this.data.rows.filter(item => item.state !== 'ok');
        for (let i = 0; i < pending.length; i += 4) {
          if (this.destroyed) return;
          const group = pending.slice(i, i + 4);
          await Promise.all(group.map(item => this.checkRow(item.key, false)));
          if (group.some(item => this.data.rows.find(entry => entry.key === item.key)?.state !== 'ok')) break;
        }
      } finally { if (!this.destroyed) this.setData({ checkingSubmission: false }); }
      if (!this.destroyed && !this.draftBusy()) this.confirmInbound();
    },
    confirmInbound() {
      const { model, templateVersion, templateFields, attributes, rows, form } = this.data;
      if (!model) return this.$toast('请先选择型号');
      if (!form.inspectionConfirmed) return this.$toast('请先确认已完成逐台实机验收');
      const seen = new Set();
      const units = [];
      for (let i = 0; i < rows.length; i++) {
        const current = rows[i], label = batch ? `第 ${i + 1} 台：` : '';
        if (current.state !== 'ok' || !isImei(current.imei1)) return this.$toast(label + (current.message || '请完成串码校验'));
        if (current.matchModelId && current.matchModelId !== model.id) return this.$toast(`${label}识别型号与所选不一致，请核验`);
        for (const code of [current.imei1, current.imei2].filter(Boolean)) { if (!isImei(code) || seen.has(code)) return this.$toast(`${label}串码无效或批内重复`); seen.add(code); }
        const values = { ...attributes, ...current.attributes }, error = validateValues(templateFields, values);
        if (error) return this.$toast(label + error);
        const cost = current.cost === '' ? form.cost : current.cost;
        if ([cost, form.retail, form.wholesale, form.agentBase].some(v => String(v).trim() === '' || !Number.isFinite(Number(v)) || Number(v) < 0)) return this.$toast(`${label}请填写有效成本与三价`);
        units.push({ imei1: current.imei1, imei2: current.imei2, attributes: values, cost });
      }
      this.setData({ submitting: true });
      wx.showModal({ title: batch ? '确认批量入库' : '确认单台入库', content: `${model.name}\n共 ${units.length} 台 · 总成本 ¥${units.reduce((sum, u) => sum + Number(u.cost), 0).toFixed(2)}\n整备中的设备将进入复检状态，暂不可售。`, success: res => {
        if (!res.confirm) { this.setData({ submitting: false }); return; }
        const common = { ...form, modelId: model.id, templateVersion, attributes };
        const request = batch ? api.inbound.createBatch({ common, units }) : api.inbound.createUnit({ ...common, ...units[0] });
        request.then(result => {
          this.clearDraft(true);
          this.setData({ rows: [row()], attributes: initialValues(templateFields), 'form.publicImages': [], 'form.inspectionConfirmed': false });
          wx.showModal({ title: '入库成功', content: `已保存 ${batch ? result.created : 1} 台设备与模板快照`, showCancel: false });
        }).catch(e => this.$toast(e.message)).finally(() => this.setData({ submitting: false }));
      }, fail: () => this.setData({ submitting: false }) });
    }
  };
};
