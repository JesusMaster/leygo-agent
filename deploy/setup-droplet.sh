#!/usr/bin/env bash
# Prepara un Droplet Ubuntu 24.04 recién creado: Docker, firewall, usuario de despliegue.
# Uso (como root, una sola vez):  bash setup-droplet.sh
set -euo pipefail

apt-get update && apt-get -y upgrade
apt-get -y install ca-certificates curl git ufw fail2ban unattended-upgrades

# Docker (repositorio oficial)
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Usuario sin privilegios para correr el servicio
id -u yisus >/dev/null 2>&1 || adduser --disabled-password --gecos "" yisus
usermod -aG docker yisus
mkdir -p /home/yisus/.ssh && cp -n /root/.ssh/authorized_keys /home/yisus/.ssh/ 2>/dev/null || true
chown -R yisus:yisus /home/yisus/.ssh && chmod 700 /home/yisus/.ssh

# Swap de 2 GB: el build de Angular (ng build) pide ~1,5 GB de pico; con 2 GB de RAM sin swap muere por OOM.
# En operación el servicio usa < 1 GB, así que el swap casi no se toca (swappiness bajo).
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10 >/dev/null && echo 'vm.swappiness=10' > /etc/sysctl.d/99-swap.conf
fi

# Firewall: solo SSH, HTTP y HTTPS
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Actualizaciones de seguridad automáticas y fail2ban con la config por defecto (sshd)
dpkg-reconfigure -f noninteractive unattended-upgrades
systemctl enable --now fail2ban

echo
echo "Listo. Ahora, como el usuario yisus:"
echo "  su - yisus"
echo "  git clone <repo> yisus-agent && cd yisus-agent"
echo "  cp .env.example .env   # y completar (o copiar el .env de la máquina actual)"
echo "  ./deploy/deploy.sh"
