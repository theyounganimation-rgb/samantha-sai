export async function prepareMessageImages(messages, bridge, socketPath) {
  const guids = [...new Set(messages.filter(m => (m.attachments ?? []).some(a =>
    a.mime_type?.startsWith('image/') && !a.is_sticker)).map(m => m.guid))];
  if (!guids.length) return {attachments: [], imageContext: []};
  try {
    const result = await bridge({operation: 'message_images', messageGuids: guids}, socketPath);
    const attachments = [], imageContext = [];
    for (const img of result.images ?? []) {
      if (!guids.includes(img.messageGuid) || img.mimeType !== 'image/jpeg' || typeof img.content !== 'string' || img.content.length > 260000 || attachments.length >= 6)
        throw new Error('Invalid image response');
      attachments.push({type: 'image', mimeType: img.mimeType, fileName: img.fileName,
        content: img.content, sizeBytes: img.sizeBytes});
      imageContext.push({imageNumber: attachments.length, messageGuid: img.messageGuid,
        attachmentGuid: img.attachmentGuid, fileName: img.fileName, status: 'pixels_attached'});
    }
    imageContext.push(...(result.notices ?? []));
    return {attachments, imageContext};
  } catch {
    return {attachments: [], imageContext: guids.map(messageGuid => ({messageGuid,
      status: 'unavailable', reason: 'Image bridge failed; metadata alone does not reveal image contents. Retry with samantha_life message_images when needed.'}))};
  }
}
