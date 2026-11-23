# Set up the feedback form

The app uses the existing embedded Google Form until the Apps Script endpoint is configured. The custom form sends responses to the same Google Form and matches its two existing questions.

1. Open your Google Form in **edit mode** while signed in as an editor. Copy the form ID from its editor URL: `https://docs.google.com/forms/d/FORM_ID/edit`. The public URL containing `/forms/d/e/` is a different ID.
2. Open [Google Apps Script](https://script.google.com/), create a project, and replace its code with the contents of `feedback-apps-script.gs`. Set `FORM_EDIT_ID` to the editor form ID. Save.
3. Choose **Deploy → New deployment → Web app**. Set **Execute as** to yourself and **Who has access** to **Anyone**, then deploy and authorize access to your form. Anyone with the deployment URL can submit responses, so the endpoint can receive unwanted submissions. The built-in honeypot and input limits reduce basic spam but do not provide comprehensive spam protection.
4. Copy the deployment's URL ending in `/exec`. In `feedback-config.js`, put that URL between the quotes in `FEEDBACK_ENDPOINT`. Save and publish the updated website files.
5. Open the website, submit a test response through About, and confirm the success message and the new response in Google Forms. If the form reports a failure, inspect Apps Script **Executions**. If the form question titles or types change, update the constants and corresponding item types in the script and deploy a new version.

The embedded result message reports success or failure from Apps Script; the page does not silently assume a cross-origin submission succeeded. If you need email notifications, enable new-response notifications in Google Forms.
