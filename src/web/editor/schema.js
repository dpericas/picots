'use strict';
// Camps de l'editor per a cada tipus de cue (claus del show.yaml).
// type: text | textarea | number | bool | select | cue | file | folder | ids | options | questions | diploma
// file: accept = video | image | audio. default: valor quan la clau no hi és (no s'escriu si coincideix).

(function () {
  const COMMON_END = [
    { key: 'seguent', label: 'Següent cue', type: 'cue', help: 'Buit = la de sota a la llista.' },
    { key: 'guio', label: 'Guió del presentador', type: 'textarea', help: 'El que ha de dir: surt al seu comandament.' },
    { key: 'notes', label: 'Notes del tècnic', type: 'textarea', help: 'Només al panell de control.' },
    { key: 'durada_estimada', label: 'Durada estimada', type: 'text', placeholder: 'p. ex. 2:30',
      help: 'Opcional: substitueix l\'estimació automàtica (segons o m:ss).' },
  ];
  const MUSIC = { key: 'musica', label: 'Música de fons', type: 'file', accept: 'audio' };

  const TYPES = {
    video: {
      label: 'Vídeo',
      fields: [
        { key: 'fitxer', label: 'Fitxer de vídeo', type: 'file', accept: 'video', required: true },
        { key: 'auto', label: 'Passar sol a la següent en acabar', type: 'bool', default: false },
        { key: 'fos', label: 'Fos encadenat en entrar (s)', type: 'number', min: 0, max: 10, step: 0.1, default: 0 },
        { key: 'rotol', label: 'Rètol (qui parla)', type: 'text', placeholder: 'p. ex. Mireia · mestra de P3',
          help: 'Surt a baix a l\'esquerra els primers 7 segons del vídeo.' },
      ],
    },
    diapositives: {
      label: 'Fotos',
      fields: [
        { key: 'carpeta', label: 'Carpeta de fotos', type: 'folder', help: 'Totes les fotos de la carpeta, per ordre de nom.' },
        { key: 'segons', label: 'Segons per foto', type: 'number', min: 1, step: 0.5, default: 4 },
        MUSIC,
      ],
    },
    votacio: {
      label: 'Votació',
      fields: [
        { key: 'pregunta', label: 'Pregunta', type: 'text', required: true },
        { key: 'opcions', label: 'Opcions', type: 'options' },
        { key: 'temps', label: 'Temps (s, 0 = sense límit)', type: 'number', min: 0, default: 30 },
        { key: 'empat', label: 'En cas d\'empat', type: 'select', default: 'aleatori',
          options: [['aleatori', 'A l\'atzar'], ['primera', 'La primera opció'], ['operador', 'Decideix el tècnic']] },
        { key: 'per_defecte', label: 'Si ningú vota', type: 'optionIndex', default: 0 },
      ],
    },
    espera: {
      label: 'Espera',
      fields: [{ key: 'text', label: 'Text a la pantalla', type: 'textarea' }, MUSIC],
    },
    entrada: {
      label: 'Entrada triomfal',
      fields: [
        { key: 'text', label: 'Text inicial', type: 'text' },
        { key: 'text_final', label: 'Text sobre el mosaic final', type: 'text' },
        MUSIC,
        { key: 'efecte', label: 'So a cada nen (sense vídeo)', type: 'file', accept: 'audio' },
        { key: 'nom_sobre_video', label: 'Nom a sota durant el vídeo de cada nen', type: 'bool', default: true },
        { key: 'ordre', label: 'Ordre (ids separats per comes)', type: 'ids', help: 'Buit = l\'ordre de la llista de participants.' },
      ],
    },
    questionari: {
      label: 'Qüestionari',
      fields: [
        { key: 'text', label: 'Text inicial', type: 'text' },
        { key: 'preguntes', label: 'Preguntes', type: 'questions' },
        { key: 'temps', label: 'Temps per pregunta (s)', type: 'number', min: 1, default: 20 },
        { key: 'classificacio', label: 'Quants surten a la classificació (0 = sense punts)', type: 'number', min: 0, default: 5 },
        { key: 'tancar_quan_tots', label: 'Mostrar la solució quan han respost tots', type: 'bool', default: true },
        MUSIC,
      ],
    },
    repte: {
      label: 'Repte',
      fields: [
        { key: 'text', label: 'Text (què han de fer)', type: 'text' },
        { key: 'modalitat', label: 'Modalitat', type: 'select', default: 'tocs',
          options: [['tocs', 'Tocar el botó fins a l\'objectiu'], ['tots', 'Que premin tots «Sóc a punt!»']] },
        { key: 'objectiu', label: 'Objectiu (tocs entre tots)', type: 'number', min: 1, default: 200 },
        { key: 'temps', label: 'Temps (s)', type: 'number', min: 1, default: 20 },
        { key: 'si_exit', label: 'Si el superen, anar a', type: 'cue', required: true },
        { key: 'si_no', label: 'Si no, anar a', type: 'cue', help: 'Buit = la de sota.' },
        MUSIC,
      ],
    },
    mencions: {
      label: 'Mencions',
      fields: [
        { key: 'text', label: 'Text inicial', type: 'text' },
        { key: 'text_final', label: 'Text final', type: 'text' },
        MUSIC,
        { key: 'efecte', label: 'So a cada nen', type: 'file', accept: 'audio' },
        { key: 'ordre', label: 'Ordre (ids separats per comes)', type: 'ids', help: 'Buit = l\'ordre de la llista. Les mencions es posen a cada participant.' },
        { key: 'diploma', label: 'Diploma imprès', type: 'diploma' },
      ],
    },
    mur: {
      label: 'Mur de missatges',
      fields: [
        { key: 'text', label: 'Consigna', type: 'text' },
        { key: 'moderacio', label: 'El tècnic aprova cada missatge', type: 'bool', default: true },
        { key: 'dibuixos', label: 'Permetre dibuixos', type: 'bool', default: true },
        { key: 'maxim_per_nen', label: 'Màxim de missatges per nen', type: 'number', min: 1, default: 3 },
        MUSIC,
      ],
    },
  };

  const COMMON_START = [
    { key: 'id', label: 'Id (únic, sense espais)', type: 'text', required: true },
    { key: 'titol', label: 'Títol', type: 'text' },
  ];

  const PARTICIPANT = [
    { key: 'id', label: 'Id', type: 'text', width: 90 },
    { key: 'nom', label: 'Nom', type: 'text', width: 120 },
    { key: 'foto', label: 'Foto', type: 'file', accept: 'image' },
    { key: 'avatar', label: 'Avatar', type: 'file', accept: 'image' },
    { key: 'video_entrada', label: 'Vídeo d\'entrada', type: 'file', accept: 'video' },
    { key: 'mencio', label: 'Menció', type: 'text' },
  ];

  const GENERAL = [
    { key: 'titol', label: 'Títol de la gala', type: 'text' },
  ];
  const NETWORK = [
    { key: 'port', label: 'Port', type: 'number', min: 1, max: 65535, default: 8080 },
    { key: 'ip_publica', label: 'IP fixa del portàtil (per als QR impresos)', type: 'text', placeholder: 'p. ex. 192.168.50.10' },
    { key: 'pin_presentador', label: 'PIN del presentador', type: 'text' },
    { key: 'pin_control', label: 'PIN del panell des d\'un altre aparell', type: 'text' },
  ];

  const EXT = {
    video: ['.mp4', '.m4v', '.mov', '.webm'],
    image: ['.jpg', '.jpeg', '.png', '.webp', '.gif'],
    audio: ['.mp3', '.m4a', '.aac', '.wav', '.ogg'],
  };

  window.EditorSchema = { TYPES, COMMON_START, COMMON_END, PARTICIPANT, GENERAL, NETWORK, EXT };
})();
