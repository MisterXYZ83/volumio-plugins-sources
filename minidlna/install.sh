#!/bin/bash

echo "Installing MiniDLNA"
apt-get update
apt-get -y install minidlna
systemctl disable minidlna.service
systemctl stop minidlna.service
rm /etc/minidlna.conf
rm /data/minidlna.conf

minidlnad=$(whereis -b minidlnad | cut -d ' ' -f2)
echo "Creating systemd unit /etc/systemd/system/minidlna.service"
echo "[Unit]
Description=MiniDLNA lightweight DLNA/UPnP-AV server
Documentation=man:minidlnad(1) man:minidlna.conf(5)
After=local-fs.target remote-fs.target nss-lookup.target network.target

[Service]
User=volumio
Group=volumio

Environment=CONFIGFILE=/data/minidlna.conf
Environment=DAEMON_OPTS=
EnvironmentFile=-/etc/default/minidlna

RuntimeDirectory=minidlna
PIDFile=/run/minidlna/minidlna.pid
ExecStart=$minidlnad -f \$CONFIGFILE -P /run/minidlna/minidlna.pid \$DAEMON_OPTS

[Install]
WantedBy=multi-user.target" > /etc/systemd/system/minidlna.service
systemctl daemon-reload

echo "Setting values for \"network_interface\" and \"model_number\" in /data/plugins/music_service/minidlna/config.json"
sed -i "/\"value\": \"eth0,wlan0\"/s/\"eth0,wlan0\"/\"$(ip -o link show | grep -v ": lo:" | cut -s -d":" -f2 | cut -s -d" " -f2 | tr "[:cntrl:]" "," | head --bytes -1)\"/1" /data/plugins/music_service/minidlna/config.json
sed -i "/\"value\": \"Volumio Edition\"/s/\"Volumio Edition\"/\"$($minidlnad -V | tr -d "[:cntrl:]")\"/1" /data/plugins/music_service/minidlna/config.json

echo "Setting permissions to MiniDLNA folders"
chown -R volumio:volumio /var/cache/minidlna/

echo "plugininstallend"
