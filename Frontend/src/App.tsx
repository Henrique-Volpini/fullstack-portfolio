import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import Home from "./pages/Home/Home";

// Componente raiz: roteamento por hash com a página inicial, e qualquer outro endereço volta para ela.
function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
export default App;
