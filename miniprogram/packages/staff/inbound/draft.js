const { initialValues, validateValues } = require('../../../utils/template');

const formFields = [
  'condition', 'supplierId', 'cost', 'wholesale', 'retail', 'agentBase', 'retailProfit', 'wholesaleProfit', 'agentProfit',
  'peerDesc', 'customerDesc', 'internalNote', 'flags',
];

const { keyFor } = require('../../../utils/inbound-draft-key');

function fileRefs(files = []) {
  return (Array.isArray(files) ? files : []).filter(file => file?.fileId).map(({ fileId, mediaType }) => ({
    fileId, ...(mediaType ? { mediaType } : {}),
  }));
}

function fieldValues(fields, values) {
  return Object.fromEntries(fields.filter(field => Object.prototype.hasOwnProperty.call(values, field.key)).map(field => [
    field.key, field.type === 'image' ? fileRefs(values[field.key]) : values[field.key],
  ]));
}

function snapshot({ model, templateId, templateVersion, templateFields, rowFields, attributes, rows, form, identifierMode, quantity, batchNoSerial, batchReason }, priceTouched) {
  return {
    savedAt: Date.now(),
    // 旧草稿没有以下字段，恢复时按手机模式处理
    identifierMode: identifierMode || 'imei',
    quantity: quantity || '1',
    batchNoSerial: !!batchNoSerial,
    batchReason: batchReason || '',
    model: model ? { id: model.id, name: model.name } : null,
    templateId,
    templateVersion,
    fieldTypes: Object.fromEntries(templateFields.map(({ key, type }) => [key, type])),
    attributes: fieldValues(templateFields, attributes),
    rows: rows.map(({ imei1, imei2, serialNo, noSerial, noSerialReason, cost, attributes }) => ({
      imei1, imei2, serialNo: serialNo || '', noSerial: !!noSerial, noSerialReason: noSerialReason || '', cost, attributes: fieldValues(rowFields, attributes),
    })),
    form: { ...Object.fromEntries(formFields.map(key => [key, form[key]])), publicImages: fileRefs(form.publicImages) },
    priceTouched: { ...priceTouched },
  };
}

function restoreFields(fields, saved, storedTypes, changed, defaults = {}) {
  for (const field of fields) {
    const value = saved[field.key];
    if (value === undefined || storedTypes[field.key] !== field.type) continue;
    if ((changed || field.type === 'select') && validateValues([{ ...field, required: false }], saved)) continue;
    defaults[field.key] = value;
  }
  return defaults;
}

function restoredValues(draft, template, rowFields) {
  const fields = template?.fields || [];
  const changed = !!template && (template.id !== draft.templateId || template.version !== draft.templateVersion);
  return {
    changed,
    attributes: restoreFields(fields, draft.attributes, draft.fieldTypes, changed, initialValues(fields)),
    rows: draft.rows.map(item => ({
      ...item, attributes: restoreFields(rowFields, item.attributes, draft.fieldTypes, changed),
    })),
  };
}

/** 旧草稿的单一利润恢复为零售利润；不再恢复核对开关。 */
function restoredForm(saved, defaults = {}) {
  const { targetProfit, inspectionConfirmed, ...form } = saved;
  return { ...defaults, ...form, retailProfit: form.retailProfit ?? targetProfit ?? '' };
}

async function refreshFiles(groups, getFile) {
  const pending = groups.flat().filter(Boolean);
  let failed = false;
  for (let i = 0; i < pending.length; i += 4) {
    await Promise.all(pending.slice(i, i + 4).map(async file => {
      try {
        const latest = await getFile(file.fileId);
        if (!latest?.url) throw Error('文件预览地址为空');
        file.url = latest.url;
      } catch (error) {
        failed = true;
      }
    }));
  }
  return failed;
}

module.exports = { keyFor, snapshot, restoredValues, restoredForm, refreshFiles };
