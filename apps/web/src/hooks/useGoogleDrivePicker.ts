import { useCallback } from "react";

/**
 * The parts of the Google Picker API Kan uses. Google ships no npm types for
 * it, so these are written by hand.
 * https://developers.google.com/workspace/drive/picker/reference
 */
interface PickerDocument {
  id: string;
}

interface PickerResponse {
  action: string;
  docs?: PickerDocument[];
}

interface PickerDocsView {
  setIncludeFolders(include: boolean): PickerDocsView;
  setEnableDrives(enable: boolean): PickerDocsView;
}

interface PickerBuilder {
  addView(view: PickerDocsView): PickerBuilder;
  enableFeature(feature: string): PickerBuilder;
  setAppId(appId: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setOrigin(origin: string): PickerBuilder;
  setTitle(title: string): PickerBuilder;
  setCallback(callback: (response: PickerResponse) => void): PickerBuilder;
  build(): { setVisible(visible: boolean): void };
}

interface GooglePickerNamespace {
  PickerBuilder: new () => PickerBuilder;
  DocsView: new (viewId?: string) => PickerDocsView;
  ViewId: { DOCS: string };
  Feature: { MULTISELECT_ENABLED: string; SUPPORT_DRIVES: string };
  Action: { PICKED: string; CANCEL: string };
}

// window.google is already typed for Google sign-in, so read it through a
// narrower view instead of redeclaring it
interface PickerWindow {
  gapi?: { load(api: string, callback: () => void): void };
  google?: { picker?: GooglePickerNamespace };
}
const pickerWindow = () => window as unknown as PickerWindow;

const GAPI_SRC = "https://apis.google.com/js/api.js";

let pickerLoader: Promise<GooglePickerNamespace> | null = null;

/** Loads Google's Picker script once per page. */
const loadPicker = () => {
  pickerLoader ??= new Promise<GooglePickerNamespace>((resolve, reject) => {
    const onGapiReady = () => {
      const { gapi } = pickerWindow();
      if (!gapi) return reject(new Error("Google API failed to load"));
      gapi.load("picker", () => {
        const picker = pickerWindow().google?.picker;
        if (picker) resolve(picker);
        else reject(new Error("Google Picker failed to load"));
      });
    };

    if (pickerWindow().gapi) return onGapiReady();

    const script = document.createElement("script");
    script.src = GAPI_SRC;
    script.async = true;
    script.onload = onGapiReady;
    script.onerror = () => reject(new Error("Google API failed to load"));
    document.body.appendChild(script);
  }).catch((error: unknown) => {
    // Let a later click try again, e.g. after a network blip
    pickerLoader = null;
    throw error;
  });
  return pickerLoader;
};

/**
 * Opens the Google Picker so the person can choose Drive files. Resolves with
 * the chosen file ids, or an empty list if they close it.
 */
export function useGoogleDrivePicker() {
  return useCallback(
    async (options: {
      accessToken: string;
      developerKey: string;
      appId: string;
      title: string;
    }) => {
      const picker = await loadPicker();

      return new Promise<string[]>((resolve) => {
        const view = new picker.DocsView(picker.ViewId.DOCS)
          .setIncludeFolders(true)
          .setEnableDrives(true);

        new picker.PickerBuilder()
          .addView(view)
          .enableFeature(picker.Feature.MULTISELECT_ENABLED)
          .enableFeature(picker.Feature.SUPPORT_DRIVES)
          // The app id lets the drive.file scope cover the picked files
          .setAppId(options.appId)
          .setDeveloperKey(options.developerKey)
          .setOAuthToken(options.accessToken)
          .setOrigin(window.location.origin)
          .setTitle(options.title)
          .setCallback((response) => {
            if (response.action === picker.Action.PICKED) {
              resolve((response.docs ?? []).map((doc) => doc.id));
            } else if (response.action === picker.Action.CANCEL) {
              resolve([]);
            }
          })
          .build()
          .setVisible(true);
      });
    },
    [],
  );
}
