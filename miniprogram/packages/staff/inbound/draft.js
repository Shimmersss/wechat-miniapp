const config = require('../../../config/index');
const { isStaff, can } = require('../../../utils/permission');
const { PERM } = require('../../../constants/roles');
const { initialValues, validateValues } = require('../../../utils/template');

const formFields = [
  'condition', 'cost', 'wholesale', 'retail', 'agentBase', 'targetProfit',
  'peerDesc', 'customerDesc', 'internalNote', 'flags',
];

function keyFor(user, batch) {
  if (!user?.id || !isStaff(user) || !can(user, PERM.INBOUND)) return '';
  const backend = config.useMock ? 'mock' : config.useCloud
    ? config.cloudHttpBaseUrl || config.cloudEnv || 'cloud-default'
    : config.baseUrl;
  return ['xm_inbound_draft_v1', config.env, backend, user.id, user.staffNo || '', user.role,
    batch ? 'batch' : 'single'].map(encodeURIComponent).join(':');
}

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

function snapshot({ model, templateId, templateVersion, templateFields, rowFields, attributes, rows, form }, priceTouched) {
  return {
    savedAt: Date.now(),
    model: model ? { id: model.id, name: model.name } : null,
    templateId,
    templateVersion,
    fieldTypes: Object.fromEntries(templateFields.map(({ key, type }) => [key, type])),
    attributes: fieldValues(templateFields, attributes),
    rows: rows.map(({ imei1, imei2, cost, attributes }) => ({
      imei1, imei2, cost, attributes: fieldValues(rowFields, attributes),
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

module.exports = { keyFor, snapshot, restoredValues, refreshFiles };
