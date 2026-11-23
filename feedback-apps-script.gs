/**
 * SyncCopyPaste feedback receiver.
 * Paste this into Google Apps Script, set FORM_EDIT_ID, then deploy as a web app.
 * FORM_EDIT_ID is the ID in the form EDITOR URL, not the public /d/e/... URL.
 */
const FORM_EDIT_ID = 'PASTE_YOUR_FORM_EDITOR_ID_HERE';
const FEEDBACK_TITLE = 'Report bugs, suggest features, or provide general feedback.';
const EMAIL_TITLE = 'Email (optional)';

function doPost(event) {
  try {
    const params = event && event.parameter || {};
    if (params.website) return resultPage('Thank you for your feedback.');
    const feedback = String(params.feedback || '').trim();
    const email = String(params.email || '').trim();
    if (!feedback || feedback.length > 10000 || email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      return resultPage('Could not send feedback. Please check the form and try again.');
    }
    const form = FormApp.openById(FORM_EDIT_ID);
    const feedbackItem = form.getItems(FormApp.ItemType.PARAGRAPH_TEXT).find(item => item.getTitle() === FEEDBACK_TITLE);
    const emailItem = form.getItems(FormApp.ItemType.TEXT).find(item => item.getTitle() === EMAIL_TITLE);
    if (!feedbackItem || !emailItem) throw new Error('Feedback form questions do not match the configured titles.');
    const response = form.createResponse().withItemResponse(feedbackItem.asParagraphTextItem().createResponse(feedback));
    if (email) response.withItemResponse(emailItem.asTextItem().createResponse(email));
    response.submit();
    return resultPage('Thank you for your feedback.');
  } catch (error) {
    console.error(error);
    return resultPage('Could not send feedback. Please try again later.');
  }
}

function resultPage(message) {
  // Only fixed messages are used here; user input is never inserted into HTML.
  return HtmlService.createHtmlOutput('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:transparent}p{margin:4px 0;font:14px/1.4 Arial,sans-serif;color:#2688cc}</style></head><body><p>' + message + '</p></body></html>')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
