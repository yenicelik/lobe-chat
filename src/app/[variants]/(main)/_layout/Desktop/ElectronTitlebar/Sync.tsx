import { ActionIcon, Input } from '@lobehub/ui';
import { Button, Form, Popover } from 'antd';
import { Wifi, WifiOffIcon } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Flexbox } from 'react-layout-kit';
import useSWR from 'swr';

import { remoteServerService } from '@/services/electron/remoteServer';

const Sync = memo(() => {
  const { t } = useTranslation('electron');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [localStatus, setLocalStatus] = useState<{
    error?: boolean;
    isActive?: boolean;
    message?: string;
  } | null>(null);

  // 使用useSWR获取远程服务器配置
  const { data: serverConfig, mutate: refreshServerConfig } = useSWR(
    'electron:getRemoteServerConfig',
    async () => {
      try {
        return await remoteServerService.getRemoteServerConfig();
      } catch (error) {
        console.error('获取远程服务器配置失败:', error);
        throw error;
      }
    },
    {
      onSuccess: (data) => {
        setServerUrl(data.remoteServerUrl || '');
        setLocalStatus(null); // 清除本地状态
      },
    },
  );

  // 服务器状态（优先使用本地状态，然后使用从服务器获取的状态）
  const serverStatus = localStatus || {
    error: !serverConfig,
    isActive: serverConfig?.isRemoteServerActive,
    message: serverConfig
      ? serverConfig.isRemoteServerActive
        ? t('remoteServer.statusConnected')
        : t('remoteServer.statusDisconnected')
      : t('remoteServer.fetchError'),
  };

  // 打开弹窗时获取配置
  const handleOpenChange = useCallback((visible: boolean) => {
    setOpen(visible);
  }, []);

  // 处理表单提交
  const handleSubmit = useCallback(
    async (values: { serverUrl: string }) => {
      if (!values.serverUrl) return;

      setLoading(true);
      try {
        // 获取当前配置
        const config = await remoteServerService.getRemoteServerConfig();

        // 如果已经激活，需要先清除
        if (config.isRemoteServerActive) {
          await remoteServerService.clearRemoteServerConfig();
        }

        // 请求授权
        const result = await remoteServerService.requestAuthorization(values.serverUrl);

        if (!result.success) {
          console.error('请求授权失败:', result.error);
          setLocalStatus({
            error: true,
            isActive: false,
            message: t('remoteServer.authError', { error: result.error }),
          });
        } else {
          setLocalStatus({
            error: false,
            isActive: false,
            message: t('remoteServer.authPending'),
          });
          // 关闭弹窗
          setOpen(false);
        }
        // 刷新状态
        refreshServerConfig();
      } catch (error) {
        console.error('远程服务器配置出错:', error);
        setLocalStatus({
          error: true,
          isActive: false,
          message: t('remoteServer.configError'),
        });
      } finally {
        setLoading(false);
      }
    },
    [t, refreshServerConfig],
  );

  // 断开连接
  const handleDisconnect = useCallback(async () => {
    setLoading(true);
    try {
      await remoteServerService.clearRemoteServerConfig();
      // 更新表单URL为空
      setServerUrl('');
      // 刷新状态
      refreshServerConfig();
    } catch (error) {
      console.error('断开连接失败:', error);
      setLocalStatus({
        error: true,
        isActive: false,
        message: t('remoteServer.disconnectError'),
      });
    } finally {
      setLoading(false);
    }
  }, [refreshServerConfig, t]);

  return (
    <Popover
      content={
        <Flexbox gap={16} padding={16} style={{ width: 300 }}>
          <Flexbox gap={8}>
            <h3 style={{ margin: 0 }}>{t('remoteServer.configTitle')}</h3>
          </Flexbox>

          <Form initialValues={{ serverUrl }} layout={'vertical'} onFinish={handleSubmit}>
            <Form.Item
              extra={
                serverStatus.message && (
                  <div style={{ color: serverStatus.error ? 'red' : 'inherit' }}>
                    {serverStatus.message}
                  </div>
                )
              }
              label={t('remoteServer.serverUrl')}
              name="serverUrl"
              rules={[
                { message: t('remoteServer.urlRequired'), required: true },
                {
                  message: t('remoteServer.invalidUrl'),
                  type: 'url',
                },
              ]}
            >
              <Input
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://example.com"
                value={serverUrl}
              />
            </Form.Item>

            <Flexbox distribution="space-between" gap={8} horizontal>
              {serverStatus.isActive ? (
                <Button danger loading={loading} onClick={handleDisconnect}>
                  {t('remoteServer.disconnect')}
                </Button>
              ) : (
                <Button htmlType="submit" loading={loading} type="primary">
                  {t('remoteServer.connect')}
                </Button>
              )}
              <Button onClick={() => setOpen(false)}>{t('cancel', { ns: 'common' })}</Button>
            </Flexbox>
          </Form>
        </Flexbox>
      }
      onOpenChange={handleOpenChange}
      open={open}
      placement="right"
      trigger="click"
    >
      <ActionIcon
        icon={serverStatus.isActive ? Wifi : WifiOffIcon}
        placement={'bottomRight'}
        size="small"
        title={t('remoteServer.configTitle')}
      />
    </Popover>
  );
});

export default Sync;
