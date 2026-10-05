import type { NextPageWithLayout } from "~/pages/_app";
import { getDashboardLayout } from "~/components/Dashboard";
import { SettingsLayout } from "~/components/SettingsLayout";
import GoogleChatSettings from "~/views/settings/GoogleChatSettings";

const GoogleChatSettingsPage: NextPageWithLayout = () => {
  return (
    <SettingsLayout currentTab="google-chat">
      <GoogleChatSettings />
    </SettingsLayout>
  );
};

GoogleChatSettingsPage.getLayout = (page) => getDashboardLayout(page);

export default GoogleChatSettingsPage;
